/**
 * Fase 6 — Validator Híbrido.
 *
 * Combina validação heurística (determinística, sem custo) com validação por
 * Critic LLM (julgamento semântico, quando necessário).
 *
 * O Critic é SEPARADO do executor. Não decide, executa e valida tudo no mesmo
 * componente.
 *
 * Política de quando chamar o Critic:
 * - Só se a heurística passar (evita gasto desnecessário em resultado já ruim)
 * - Só se complexity === "alta" (tarefas simples não precisam de julgamento semântico)
 * - Configurável via enableCritic
 */

import type { ProviderAdapter } from "../providers/types.js";
import type { ChatCompletionRequest } from "../schemas/chat.js";
import type { LLMRunner } from "./runtime.js";
import type { TaskProfile, TaskCapability } from "./taskAnalyzer.js";
import type { Observation, ValidationResult } from "./types.js";
import type { ModelEntry } from "./modelCatalog.js";
import { estimateMessagesTokens, estimateTextTokens } from "./tokenEstimator.js";
import { costPriceFor, estimateCostUsd } from "./costEstimator.js";
import { buildCandidateList, completeWithFallback, type FallbackCandidate } from "./providerFallback.js";

export interface ValidatorOptions {
  enableCritic: boolean;
  criticModel?: string;
  profile: TaskProfile;
  runner?: LLMRunner;
  providers: Map<string, ProviderAdapter>;
  catalog?: readonly ModelEntry[];
  /** Ranking do F2 — cadeia de fallback do critic (ver providerFallback.ts). */
  rankedCandidates?: readonly FallbackCandidate[];
  onProgress?: import("./progress.js").ProgressEmitter;
}

/**
 * Validação Híbrida: Heurísticas + Critic LLM.
 */
export async function validateStep(
  task: string,
  stepDescription: string,
  observation: Observation,
  capability: TaskCapability,
  options: ValidatorOptions
): Promise<ValidationResult> {
  // 1. Heurística (determinística)
  const heuristic = validateHeuristics(observation, capability);

  // Etapa executou uma FERRAMENTA real (filesystem/shell/http) — não texto
  // gerado por LLM. O Critic serve para julgar SEMANTICAMENTE uma resposta
  // gerada (ela "atende ao objetivo"? "é coerente"?); dado bruto de
  // ferramenta (ex.: o conteúdo literal de um arquivo lido) não é uma
  // resposta a ser julgada por "qualidade" — é um fato determinístico que
  // ou aconteceu (success/error) ou não. Deixar o Critic reavaliar isso
  // introduzia rejeições falsas e não-determinísticas (a mesma leitura do
  // mesmo arquivo podia passar numa tentativa e falhar na próxima, sem o
  // conteúdo ter mudado), travando o loop em correções inúteis até
  // max_iterations. Etapas de tool real usam SÓ a heurística determinística.
  const isRealToolRun =
    observation.toolName === "filesystem" ||
    observation.toolName === "shell" ||
    observation.toolName === "http" ||
    observation.toolName === "document" ||
    observation.toolName === "compression" ||
    observation.toolName === "image" ||
    (!observation.toolName.startsWith("llm:") && observation.toolName !== "unknown");

  if (isRealToolRun || !options.enableCritic) {
    return {
      passed: heuristic.passed,
      validatorType: "heuristic",
      confidence: 1.0,
      issues: heuristic.issues,
      suggestedCorrection: null,
      costUsd: 0,
      tokens: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    };
  }

  // 2. Critic LLM (apenas se heurística passou E complexity alta E habilitado
  //    E a etapa NÃO foi uma execução real de ferramenta — ver acima)
  if (
    options.enableCritic &&
    heuristic.passed &&
    options.profile.complexity === "alta" &&
    options.criticModel
  ) {
    const critic = await validateWithCritic(
      task,
      stepDescription,
      observation.output ?? "",
      options.criticModel,
      options.runner,
      options.providers,
      options.catalog,
      options.rankedCandidates ?? [],
      options.onProgress
    );

    return {
      passed: heuristic.passed && critic.passed,
      validatorType: "critic_llm",
      confidence: critic.confidence,
      issues: [...heuristic.issues, ...critic.issues],
      suggestedCorrection: critic.suggestedCorrection,
      costUsd: critic.costUsd,
      tokens: {
        inputTokens: critic.tokens.input,
        outputTokens: critic.tokens.output,
        totalTokens: critic.tokens.total,
      },
    };
  }

  // 3. Apenas heurística (sem critic)
  return {
    passed: heuristic.passed,
    validatorType: "heuristic",
    confidence: 1.0,
    issues: heuristic.issues,
    suggestedCorrection: null,
    costUsd: 0,
    tokens: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  };
}

/**
 * Validação Heurística (Determinística).
 */
function validateHeuristics(
  observation: Observation,
  capability: TaskCapability
): { passed: boolean; issues: string[] } {
  const issues: string[] = [];
  const { output, error, toolName, success } = observation;

  // Fase 8 — execução via TOOL: valida o SUCESSO da ferramenta, não o formato
  // de código. Uma tool filesystem/shell/http que retornou success=true
  // cumpriu a ação; exigir bloco de código aqui seria falso-negativo.
  // Restrito aos nomes REAIS de tools — toolName "llm:gemini" é LLM, não tool.
  const isToolRun =
    toolName === "filesystem" ||
    toolName === "shell" ||
    toolName === "http" ||
    toolName === "document" ||
    toolName === "compression" ||
    toolName === "image" ||
    (!toolName.startsWith("llm:") && toolName !== "unknown");
  if (isToolRun) {
    if (success === false || error) {
      issues.push(`Falha na tool ${toolName}${error ? `: ${error}` : ""}`);
      return { passed: false, issues };
    }
    if (observation.metadata.operation === "list") {
      if (!isStructuredListEvidence(observation.output)) {
        issues.push("A listagem filesystem não retornou evidência estruturada com entradas.");
        return { passed: false, issues };
      }
    }
    // Tool executou com sucesso → válida
    return { passed: true, issues };
  }

  // Erro técnico
  if (error) {
    issues.push(`Erro técnico: ${error}`);
    return { passed: false, issues };
  }

  // Saída vazia
  if (!output || output.trim().length === 0) {
    issues.push("Saída vazia de conteúdo.");
    return { passed: false, issues };
  }

  // Regras por capacidade
  if (capability === "geracao_codigo") {
    // Resposta cortada pelo limite de tokens do provedor (finish_reason /
    // stop_reason = "length"): o conteúdo pode até PARECER válido (ter bloco
    // de código, palavras-chave, etc.) mas está incompleto no meio de uma
    // função/arquivo — aceitar isso como sucesso entrega código quebrado ao
    // usuário sem nenhum aviso. Falha aqui força uma correção (que já herda
    // o orçamento de tokens maior de `maxTokensForCapability`).
    if (observation.metadata?.["finishReason"] === "length") {
      issues.push(
        "Resposta truncada pelo limite de tokens do provedor (finish_reason=length) — código incompleto, não pode ser aceito como final."
      );
      return { passed: false, issues };
    }

    const hasCodeBlock = /```[\s\S]*```/.test(output);
    const hasCodeKeywords = /\b(const|let|var|function|def|class|return|import|export|public|private)\b/.test(output);
    // JSDoc/comentários de documentação são código válido, mas não contêm
    // necessariamente palavras-chave de linguagem nem vêm cercados por ```
    // (o modelo às vezes cola o comentário puro, às vezes sem nenhuma tag
    // @param/@returns se a função não tiver parâmetros/retorno relevante
    // a documentar). Qualquer comentário de bloco (`/** ... */` ou até
    // `//`) já é sinal suficiente de que é código/documentação real, não
    // texto solto sobre o assunto.
    const hasDocComment = /\/\*\*[\s\S]*?\*\//.test(output) || /^\s*\/\//m.test(output);
    // Regra final, deliberadamente permissiva: as checagens de sintaxe
    // acima pegam a maioria dos casos reais, mas são inerentemente
    // incompletas — cobrem um subconjunto arbitrário de estilos de código
    // válidos (decorators, JSX, interfaces TS, métodos de objeto sem a
    // palavra "function", etc. não batem em nenhuma). Isso já reprovou
    // por engano uma resposta de JSDoc genuinamente correta, 3 vezes
    // seguidas, até esgotar o orçamento de iterações do loop sem nunca
    // chegar a escrever o arquivo. Uma resposta com desenvolvimento
    // substancial (>=60 caracteres) que não seja claramente uma recusa
    // ("não posso", "não é possível") é aceita mesmo sem bater nenhuma
    // sintaxe específica — o objetivo desta heurística é filtrar respostas
    // vazias/recusas, não validar estilo de código.
    const looksLikeRefusal = /^(não posso|não é possível|desculpe|infelizmente não)/i.test(output.trim());
    const hasSubstance = output.trim().length >= 60 && !looksLikeRefusal;
    if (!hasCodeBlock && !hasCodeKeywords && !hasDocComment && !hasSubstance) {
      issues.push("Para geração de código, a resposta deve conter estrutura ou sintaxe de código evidente.");
    }
  } else if (capability === "analise") {
    if (output.length < 50) {
      issues.push("Análise excessivamente curta (menos de 50 caracteres).");
    }
  } else if (capability === "validacao") {
    if (output.length < 30) {
      issues.push("Validação muito curta (menos de 30 caracteres).");
    }
  } else if (capability === "planejamento") {
    // Heurística antiga exigia palavras-chave literais em português
    // ("etapa", "passo", "fase", "plano", "1.", "- ") — um plano
    // genuinamente bom, mas escrito sem essas palavras exatas (ex.: uma
    // lista numerada em formato "1)" em vez de "1.", ou prosa corrida
    // logicamente sequencial), reprovava só na primeira tentativa,
    // gastando o dobro do orçamento de iterações do loop à toa. O
    // critério agora é mais tolerante: qualquer sinal de estrutura
    // sequencial (numeração em qualquer formato, marcadores de lista,
    // ou um tamanho mínimo que sugira desenvolvimento real da resposta)
    // já é suficiente — a exigência real é "não é uma frase vazia",
    // não "usa exatamente esta palavra".
    const hasSequenceMarker = /(^|\n)\s*(\d+[.).:]|[-*•]|primeiro|segundo|terceiro|em seguida|depois|então)\s/i.test(
      `\n${output}`
    );
    const hasPlanningVocabulary = /\b(etapa|passo|fase|plano|abordagem|estratégia)\b/i.test(output);
    if (!hasSequenceMarker && !hasPlanningVocabulary && output.length < 80) {
      issues.push("Planejamento deve conter estrutura de etapas/passos ou desenvolvimento suficiente.");
    }
  } else if (capability === "execucao_ferramenta") {
    // Chegamos aqui só quando a etapa NÃO passou pelo branch `isToolRun`
    // acima — ou seja, a ação real não aconteceu (a ferramenta não rodou;
    // o modelo só respondeu com texto sobre a ação). Isso é, por
    // definição, uma falha desta capability: o propósito dela é produzir
    // uma execução real, não uma descrição. Sinalizamos explicitamente em
    // vez de deixar cair no "sucesso por padrão" de uma etapa textual
    // qualquer — que era exatamente o comportamento que mascarava o
    // problema antes desta correção.
    issues.push(
      "Etapa de execução de ferramenta não executou uma ferramenta real — produziu apenas texto/código sobre a ação, não a ação em si."
    );
  }

  return {
    passed: issues.length === 0,
    issues,
  };
}

function isStructuredListEvidence(output: string | null): boolean {
  if (!output) return false;
  try {
    const parsed = JSON.parse(output) as { tool?: string; action?: string; entries?: unknown[] };
    // Aceita tanto "filesystem" quanto "compression" — ambas as tools podem
    // produzir uma operação "list" com esse mesmo formato de evidência
    // ({tool, action: "list", entries: [...]}). Antes só "filesystem" era
    // aceito aqui, então uma listagem de .zip/.rar bem-sucedida via
    // CompressionTool (que genuinamente retornava entradas reais) era
    // rejeitada por este check e o loop desistia com "no_progress" mesmo
    // com a tool tendo funcionado perfeitamente.
    return (
      (parsed.tool === "filesystem" || parsed.tool === "compression") &&
      parsed.action === "list" &&
      Array.isArray(parsed.entries) &&
      parsed.entries.length > 0
    );
  } catch {
    return false;
  }
}

/**
 * Validação por Critic LLM (Julgamento Semântico).
 */
async function validateWithCritic(
  task: string,
  stepDesc: string,
  outputContent: string,
  model: string,
  runner: LLMRunner | undefined,
  providers: Map<string, ProviderAdapter>,
  catalog?: readonly ModelEntry[],
  rankedCandidates: readonly FallbackCandidate[] = [],
  onProgress?: import("./progress.js").ProgressEmitter
): Promise<{
  passed: boolean;
  confidence: number;
  issues: string[];
  suggestedCorrection: string | null;
  costUsd: number | null;
  tokens: { input: number; output: number; total: number };
}> {
  const criticPrompt = `Você é o agente CRITIC. Avalie o resultado de uma ação executada em relação à tarefa principal.
Responda APENAS em formato JSON com o seguinte schema exato:
{
  "passed": boolean,
  "confidence": number (0.0 a 1.0),
  "issues": string[],
  "suggestedCorrection": string ou null
}

Critérios:
- O resultado atende ao objetivo da etapa?
- Há erros lógicos ou técnicos?
- Falta informação essencial?
- A qualidade é aceitável para o contexto?`;

  const userContent = `Tarefa Principal: ${task}
Etapa Avaliada: ${stepDesc}
Resultado Produzido:
${outputContent}`;

  // Fase 8 — provider do critic:
  // `model.split("/")[0]` é impreciso para modelos como Groq `openai/gpt-oss-120b`
  // (daria "openai" em vez de "groq"). Resolve o provider REAL pelo catálogo;
  // fallback para o primeiro segmento apenas quando o modelo não está no catálogo.
  let criticProvider = model.split("/")[0] ?? model;
  const catalogEntry = catalog?.find((entry) => entry.model === model);
  if (catalogEntry && providers.has(catalogEntry.provider)) {
    criticProvider = catalogEntry.provider;
  }

  const request: ChatCompletionRequest = {
    provider: criticProvider as ChatCompletionRequest["provider"],
    model,
    messages: [
      { role: "system", content: criticPrompt },
      { role: "user", content: userContent },
    ],
    temperature: 0.2,
    max_tokens: 500,
    stream: false,
    tool_choice: "none",
  };

  try {
    const candidates = buildCandidateList(criticProvider, model, rankedCandidates, providers);
    const { response: res } = await completeWithFallback(
      (candidate) => ({ ...request, provider: candidate.provider as ChatCompletionRequest["provider"], model: candidate.model }),
      providers,
      candidates,
      { runner, onProgress }
    );

    const cleanJson = res.content.replace(/```json\n?|\n?```/g, "").trim();
    const parsed = JSON.parse(cleanJson) as {
      passed?: boolean;
      confidence?: number;
      issues?: string[];
      suggestedCorrection?: string | null;
    };

    const inputTokens = res.usage?.prompt_tokens ?? estimateMessagesTokens(request.messages);
    const outputTokens = res.usage?.completion_tokens ?? estimateTextTokens(res.content);
    const price = costPriceFor(model, catalog);
    const costUsd = price ? estimateCostUsd(price, inputTokens, outputTokens) : null;

    return {
      passed: Boolean(parsed.passed),
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.8,
      issues: Array.isArray(parsed.issues) ? parsed.issues : [],
      suggestedCorrection: parsed.suggestedCorrection ?? null,
      costUsd,
      tokens: { input: inputTokens, output: outputTokens, total: inputTokens + outputTokens },
    };
  } catch {
    // Fallback seguro: assume passou com confiança baixa
    return {
      passed: true,
      confidence: 0.5,
      issues: ["Critic LLM indisponível ou resposta inválida — fallback heurística."],
      suggestedCorrection: null,
      costUsd: null,
      tokens: { input: 0, output: 0, total: 0 },
    };
  }
}
