/**
 * Fase 6 — Real Planner.
 *
 * Produz um plano ESTRUTURADO baseado na tarefa real (não apenas capabilities).
 * Usa LLM quando disponível; fallback determinístico quando o LLM falha.
 *
 * O planner recebe contexto de memórias recuperadas para melhorar decisões.
 */

import type { ProviderAdapter } from "../providers/types.js";
import type { ChatCompletionRequest, ChatMessage } from "../schemas/chat.js";
import type { LLMRunner } from "./runtime.js";
import { isWorkspaceInspectionIntent, stripCodeGenerationForReadOnlyIntent, type TaskProfile, type TaskCapability } from "./taskAnalyzer.js";
import type { Plan, PlanStep } from "./types.js";
import type { RetrievedMemory } from "./memoryRetrieval.js";
import { buildCandidateList, completeWithFallback, type FallbackCandidate } from "./providerFallback.js";

export interface PlannerResult {
  plan: Plan;
  fallbackUsed: boolean;
  /** Razão de fallback (quando aplicável). */
  fallbackReason?: string;
}

/**
 * Planner LLM — gera plano estruturado a partir da tarefa.
 */
export async function planTask(
  task: string,
  profile: TaskProfile,
  runner: LLMRunner | undefined,
  providers: Map<string, ProviderAdapter>,
  decisionProvider: string | null,
  decisionModel: string | null,
  retrievedMemory: RetrievedMemory[],
  maxPlanSteps: number,
  rankedCandidates: readonly FallbackCandidate[] = [],
  onProgress?: import("./progress.js").ProgressEmitter
): Promise<PlannerResult> {
  // Sem provider/modelo → fallback determinístico
  if (!decisionProvider || !decisionModel) {
    return {
      plan: createFallbackPlan(profile, maxPlanSteps),
      fallbackUsed: true,
      fallbackReason: "No provider/model available",
    };
  }

  // Sem runner e sem provider → fallback
  if (!runner && !providers.has(decisionProvider)) {
    return {
      plan: createFallbackPlan(profile, maxPlanSteps),
      fallbackUsed: true,
      fallbackReason: "No runner or provider available",
    };
  }

  const systemPrompt = buildPlannerPrompt(maxPlanSteps);
  const userContent = buildUserContent(task, profile, retrievedMemory);

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userContent },
  ];

  try {
    const candidates = buildCandidateList(decisionProvider, decisionModel, rankedCandidates, providers);
    const { response: res } = await completeWithFallback(
      (candidate) => ({
        provider: candidate.provider as ChatCompletionRequest["provider"],
        model: candidate.model,
        messages,
        temperature: 0.3,
        max_tokens: 2000,
        stream: false,
        tool_choice: "none",
      }),
      providers,
      candidates,
      { runner, onProgress }
    );

    const plan = parsePlanFromResponse(res.content, maxPlanSteps);

    if (!plan || plan.steps.length === 0) {
      throw new Error("Planner returned empty plan");
    }

    if (!validatePlan(plan)) {
      throw new Error("Planner returned invalid plan");
    }

    const normalizedPlan = ensureFilesystemStepFirst(
      ensureWorkspaceInspectionStep(
        stripStepsAfterLastToolWhenImmediateStop(
          ensureContentStepsDependOnToolRead(stripCodeGenerationSteps(plan, profile)),
          profile
        ),
        profile,
        maxPlanSteps
      ),
      profile,
      maxPlanSteps
    );
    if (!validatePlan(normalizedPlan)) {
      throw new Error("Planner returned invalid normalized plan");
    }

    return { plan: normalizedPlan, fallbackUsed: false };
  } catch {
    // Fallback determinístico
    return {
      plan: createFallbackPlan(profile, maxPlanSteps),
      fallbackUsed: true,
      fallbackReason: "LLM planner failed, using deterministic fallback",
    };
  }
}

/**
 * Constrói o prompt do planner.
 */
function buildPlannerPrompt(maxPlanSteps: number): string {
  return `Você é o agente PLANNER. Transforme uma tarefa em um plano executável estruturado.

REGRAS:
1. Responda APENAS em formato JSON válido. Sem texto antes ou depois.
2. O plano deve ter entre 1 e ${maxPlanSteps} etapas.
3. Cada etapa deve ter: id, index, description, objective, capability, dependencies, status.
4. "capability" deve ser uma de: analise, planejamento, geracao_codigo, execucao_ferramenta, validacao, raciocinio, conversa.
5. "dependencies" é array de IDs de etapas que esta etapa depende (devem vir antes).
6. "status" inicial de TODAS as etapas deve ser "pending".
7. O plano deve ser uma sequência lógica de execução (não paralela).
8. Etapas de validacao devem vir APÓS as etapas que elas validam.
9. Se a tarefa pedir uma AÇÃO REAL (criar/ler/escrever um arquivo, rodar um
   comando, chamar uma URL) — não apenas escrever ou explicar código sobre
   como fazer isso — inclua uma etapa com capability "execucao_ferramenta"
   que de fato realiza essa ação. Essa etapa é executada por uma
   ferramenta real (não por texto do modelo), então sua "description" e
   "objective" devem ser CONCRETOS e citar os valores exatos da tarefa
   (nome/caminho do arquivo, conteúdo exato, comando exato) — não descreva
   a etapa em termos vagos como "planejar a criação" ou "definir a
   abordagem", isso pertence a uma etapa de planejamento separada, não à
   etapa de execução em si.
9.1. A ferramenta "execucao_ferramenta" também sabe criar ZIP, PDF e
    gráficos SVG (barra/pizza/fluxograma) — não apenas ler/escrever/listar
    arquivos de texto. Ao descrever essa etapa para um desses casos, cite
    SEMPRE: o nome/caminho do arquivo de saída com a extensão certa
    (.zip/.pdf/.svg), e para PDF o marcador explícito "com o conteúdo:"
    seguido do texto exato, e para gráfico o marcador explícito "com os
    dados:" seguido de pares "rótulo:valor" separados por vírgula (ou só
    rótulos, em ordem, para fluxograma). Para ZIP, cite os caminhos exatos
    dos arquivos-fonte JÁ EXISTENTES a compactar.
10. Se a tarefa envolver apenas escrever/gerar código (sem executar nada de
    verdade), siga: analise → planejamento → geracao_codigo → validacao.
11. Se a tarefa for de INVESTIGAÇÃO/LEITURA/AUDITORIA (ex.: "analise",
    "investigue", "leia", "não altere nenhum arquivo") — sem pedido
    AFIRMATIVO de criar/escrever/alterar/gerar um arquivo real — o plano
    NUNCA deve incluir uma etapa com capability "geracao_codigo", e a(s)
    etapa(s) "execucao_ferramenta" devem ser exclusivamente de leitura ou
    listagem (nunca escrita).
12. Se uma etapa analisa, resume ou valida o CONTEÚDO obtido por uma etapa
    "execucao_ferramenta" (ex.: "leia o arquivo X" seguido de "analise o
    conteúdo lido"), ela DEVE declarar essa etapa de leitura em
    "dependencies" — nunca pode vir antes dela na ordem de execução.
13. Se a tarefa listar operações EXATAS a executar e disser para parar
    logo depois (ex.: "faça somente X e Y, depois pare imediatamente"),
    o plano deve conter APENAS as etapas necessárias para X e Y — NUNCA
    acrescente uma etapa final de "formatar relatório", "validar
    resultado", "consolidar resposta" ou similar. Essa etapa extra não foi
    pedida, e o relatório final já é montado automaticamente a partir da
    evidência real coletada pelas etapas de ferramenta.
14. Não inclua campos opcionais vazios.

EXEMPLO DE RESPOSTA (tarefa: "crie o arquivo notas.txt com o texto 'oi'"):
{
  "steps": [
    {
      "id": "step-1",
      "index": 0,
      "description": "Analisar a tarefa e identificar requisitos",
      "objective": "Confirmar nome do arquivo e conteúdo exato pedidos",
      "capability": "analise",
      "dependencies": [],
      "status": "pending"
    },
    {
      "id": "step-2",
      "index": 1,
      "description": "Criar o arquivo notas.txt contendo exatamente 'oi'",
      "objective": "Escrever o arquivo notas.txt com o conteúdo 'oi'",
      "capability": "execucao_ferramenta",
      "dependencies": ["step-1"],
      "status": "pending"
    },
    {
      "id": "step-3",
      "index": 2,
      "description": "Validar que o arquivo foi criado com o conteúdo correto",
      "objective": "Ler notas.txt de volta e confirmar que o conteúdo é 'oi'",
      "capability": "validacao",
      "dependencies": ["step-2"],
      "status": "pending"
    }
  ]
}`;
}

/**
 * Constrói o conteúdo do usuário com contexto de memória.
 */
function buildUserContent(
  task: string,
  profile: TaskProfile,
  retrievedMemory: RetrievedMemory[]
): string {
  const memoryContext = retrievedMemory.length > 0
    ? `\n\nEXPERIÊNCIAS ANTERIORES RELEVANTES:\n${retrievedMemory
        .slice(0, 5)
        .map((m, i) => `${i + 1}. ${m.memory.content_json.substring(0, 200)}...`)
        .join("\n")}`
    : "";

  const toolHint = profile.toolIntent
    ? `\n\n⚠️ ESTA TAREFA EXIGE UMA AÇÃO REAL (ferramenta: ${profile.toolIntent}). O plano DEVE incluir pelo menos uma etapa com capability "execucao_ferramenta" que realize essa ação — não basta gerar/explicar código sobre como fazê-la.`
    : "";

  return `TAREFA: ${task}

PERFIL DA TAREFA:
- Complexidade: ${profile.complexity}
- Categoria: ${profile.category}
- Capacidades requeridas: ${profile.capabilities.join(", ")}
- Dicas: ${profile.hints.join("; ") || "nenhuma"}
${toolHint}

${memoryContext}

Gere um plano estruturado para executar esta tarefa.`;
}

/**
 * Faz parse do plano a partir da resposta do LLM.
 */
function parsePlanFromResponse(content: string, maxPlanSteps: number): Plan | null {
  // Remove code fences se houver
  const cleanJson = content.replace(/```json\n?|\n?```/g, "").trim();

  try {
    const parsed = JSON.parse(cleanJson) as {
      steps?: Array<{
        id?: string;
        index?: number;
        description?: string;
        objective?: string;
        capability?: TaskCapability;
        dependencies?: string[];
        status?: string;
      }>;
    };

    if (!parsed.steps || !Array.isArray(parsed.steps) || parsed.steps.length === 0) {
      return null;
    }

    const steps: PlanStep[] = parsed.steps.slice(0, maxPlanSteps).map((step, idx) => ({
      id: step.id ?? `step-${idx}`,
      index: step.index ?? idx,
      description: step.description ?? `Etapa ${idx + 1}`,
      objective: step.objective ?? `Executar: ${step.description ?? `Etapa ${idx + 1}`}`,
      capability: step.capability ?? "raciocinio",
      dependencies: step.dependencies ?? [],
      status: "pending",
      attempts: 0,
      maxAttempts: 3,
    }));

    return {
      id: `plan-${Date.now()}`,
      steps,
      nextStepId: steps.length > 0 ? steps[0]!.id : null,
    };
  } catch {
    return null;
  }
}

/**
 * Valida a estrutura do plano.
 */
function validatePlan(plan: Plan): boolean {
  if (!plan.steps || plan.steps.length === 0) {
    return false;
  }

  // IDs únicos
  const ids = plan.steps.map((s) => s.id).filter(Boolean);
  if (new Set(ids).size !== ids.length) {
    return false;
  }

  // Dependencies referenciam IDs existentes
  const idsSet = new Set(plan.steps.map((s) => s.id).filter(Boolean));
  for (const step of plan.steps) {
    if (step.dependencies) {
      for (const dep of step.dependencies) {
        if (!idsSet.has(dep)) {
          return false;
        }
      }
    }
  }

  // Sem ciclos de dependência (verificação completa, não só auto-referência)
  const visited = new Set<string>();
  const inStack = new Set<string>();

  function hasCycle(stepId: string): boolean {
    if (inStack.has(stepId)) return true;
    if (visited.has(stepId)) return false;

    inStack.add(stepId);
    const step = plan.steps.find((s) => s.id === stepId);
    if (step?.dependencies) {
      for (const dep of step.dependencies) {
        if (hasCycle(dep)) return true;
      }
    }
    inStack.delete(stepId);
    visited.add(stepId);
    return false;
  }

  for (const step of plan.steps) {
    if (hasCycle(step.id)) {
      return false;
    }
  }

  // Pelo menos uma etapa pending
  if (!plan.steps.some((s) => s.status === "pending")) {
    return false;
  }

  // Campos obrigatórios
  for (const step of plan.steps) {
    if (!step.id || !step.description || !step.capability) {
      return false;
    }
  }

  return true;
}

/**
 * Fallback determinístico: cria plano a partir das capabilities.
 */
function createFallbackPlan(profile: TaskProfile, maxPlanSteps: number): Plan {
  // Tarefa CONFIRMADAMENTE read/list (ex.: "leia X", "não altere nenhum
  // arquivo") nunca deve ganhar uma etapa "Implementar o código necessário"
  // só porque uma keyword de código bateu por coincidência (ex.: "scripts").
  const safeCapabilities = stripCodeGenerationForReadOnlyIntent(
    profile.capabilities,
    profile.filesystemIntent
  );
  const orderedCaps = orderCapabilitiesForPlan(safeCapabilities);
  const steps: PlanStep[] = orderedCaps.slice(0, maxPlanSteps).map((cap, idx) => ({
    id: `fallback-${cap}-${idx}`,
    index: idx,
    description: describeCapability(cap),
    objective: `Executar a capacidade ${cap}`,
    capability: cap,
    dependencies: idx > 0 ? [`fallback-${orderedCaps[idx - 1]}-${idx - 1}`] : [],
    status: "pending",
    attempts: 0,
    maxAttempts: 3,
  }));

  if (steps.length === 0) {
    steps.push({
      id: "fallback-general-0",
      index: 0,
      description: "Executar tarefa geral",
      objective: `Executar a tarefa: ${profile.text.substring(0, 100)}...`,
      capability: "raciocinio",
      dependencies: [],
      status: "pending",
      attempts: 0,
      maxAttempts: 3,
    });
  }

  const plan: Plan = {
    id: `plan-fallback-${Date.now()}`,
    steps,
    nextStepId: steps.length > 0 ? steps[0]!.id : null,
  };

  return ensureFilesystemStepFirst(
    ensureWorkspaceInspectionStep(
      stripStepsAfterLastToolWhenImmediateStop(ensureContentStepsDependOnToolRead(plan), profile),
      profile,
      maxPlanSteps
    ),
    profile,
    maxPlanSteps
  );
}

/**
 * Quando a tarefa pede explicitamente para parar logo após as operações
 * pedidas ("depois pare imediatamente"), remove qualquer etapa que venha
 * DEPOIS da última etapa de `execucao_ferramenta` do plano — normalmente um
 * step de "validar/formatar relatório final" que o planner LLM tende a
 * acrescentar por hábito (todo plano "deveria" terminar assim), mas que
 * aqui viola a instrução do usuário: dispara uma chamada de LLM (e,
 * consequentemente, fallback entre provedores) para um trabalho que a
 * tarefa disse explicitamente para não fazer.
 *
 * O relatório final em si NÃO se perde: `runAutonomous` sempre monta o
 * `finalResult` a partir da evidência real já coletada quando o plano
 * termina logo após uma etapa de ferramenta (ver `buildEvidenceOnlyAnswer`
 * em `autonomous.ts`) — então cortar aqui é estritamente uma etapa a menos
 * de LLM, nunca uma perda de informação.
 */
function stripStepsAfterLastToolWhenImmediateStop(plan: Plan, profile: TaskProfile): Plan {
  if (!profile.stopsImmediatelyAfterTools) return plan;

  const lastToolIndex = plan.steps.reduce(
    (last, step, i) => (step.capability === "execucao_ferramenta" ? i : last),
    -1
  );
  // Sem nenhuma etapa de ferramenta no plano, não há "depois da última tool"
  // bem definido — não mexe (evita cortar o plano inteiro por engano).
  if (lastToolIndex < 0 || lastToolIndex === plan.steps.length - 1) return plan;

  const keptIds = new Set(plan.steps.slice(0, lastToolIndex + 1).map((s) => s.id));
  return {
    ...plan,
    steps: plan.steps
      .slice(0, lastToolIndex + 1)
      // Remove dependências apontando para etapas cortadas (não deveria
      // existir, já que dependências só apontam pra trás, mas por segurança).
      .map((step) => ({ ...step, dependencies: step.dependencies.filter((d) => keptIds.has(d)) })),
  };
}

/** Descrição/objetivo indica que a etapa CONSOME conteúdo obtido por uma tool real. */
const CONSUMES_TOOL_CONTENT = /\b(conte[úu]do (lido|obtido|retornado)|informa[çc][õo]es (extra[íi]das|obtidas)|dados (obtidos|lidos|retornados)|resultado (obtido|da leitura)|texto lido)\b/i;

/**
 * Garante que uma etapa que analisa/extrai/valida o CONTEÚDO obtido por uma
 * ferramenta real (ex.: "analise o conteúdo lido") declare essa etapa de
 * leitura como dependência — nunca a antecipe.
 *
 * Sem isso, `selectNextStep` (que apenas verifica dependências declaradas,
 * não ordem de dados) podia escolher "Analisar o conteúdo lido" como a
 * PRIMEIRA etapa executável — antes de "Ler o arquivo X" — porque nenhuma
 * dependência entre as duas havia sido declarada pelo LLM planner. O agente
 * então respondia sem nenhuma evidência real, mesmo que a leitura real
 * acontecesse (com sucesso) mais tarde no mesmo plano.
 *
 * Só ADICIONA dependências (nunca remove), e nunca cria um ciclo: pula
 * qualquer tool step que já dependa (direta ou transitivamente) da própria
 * etapa consumidora.
 */
function ensureContentStepsDependOnToolRead(plan: Plan): Plan {
  const toolSteps = plan.steps.filter((s) => s.capability === "execucao_ferramenta");
  if (toolSteps.length === 0) return plan;

  const dependsOn = (fromId: string, targetId: string, seen = new Set<string>()): boolean => {
    if (fromId === targetId) return true;
    if (seen.has(fromId)) return false;
    seen.add(fromId);
    const step = plan.steps.find((s) => s.id === fromId);
    if (!step) return false;
    return step.dependencies.some((dep) => dependsOn(dep, targetId, seen));
  };

  const steps = plan.steps.map((step) => {
    if (step.capability === "execucao_ferramenta") return step;
    const text = `${step.description} ${step.objective ?? ""}`;
    if (!CONSUMES_TOOL_CONTENT.test(text)) return step;

    const missingToolDeps = toolSteps
      .filter((toolStep) => toolStep.id !== step.id)
      // Não cria ciclo: pula tool step que já depende desta etapa.
      .filter((toolStep) => !dependsOn(toolStep.id, step.id))
      .filter((toolStep) => !step.dependencies.includes(toolStep.id))
      .map((toolStep) => toolStep.id);

    if (missingToolDeps.length === 0) return step;
    return { ...step, dependencies: [...step.dependencies, ...missingToolDeps] };
  });

  return { ...plan, steps };
}

function ensureFilesystemStepFirst(plan: Plan, profile: TaskProfile, maxPlanSteps: number): Plan {
  if (profile.toolIntent !== "filesystem") {
    return plan;
  }

  const toolIndex = plan.steps.findIndex((step) => step.capability === "execucao_ferramenta");
  const listIndex = plan.steps.findIndex((step) =>
    /\b(listar|liste|list|ls|filesystem\s+list)\b/i.test(`${step.description} ${step.objective ?? ""}`)
  );
  const concreteToolIndex = listIndex >= 0 ? listIndex : toolIndex;

  if (concreteToolIndex >= 0 && plan.steps[concreteToolIndex]!.capability !== "execucao_ferramenta") {
    plan.steps[concreteToolIndex] = {
      ...plan.steps[concreteToolIndex]!,
      capability: "execucao_ferramenta",
      objective: `${plan.steps[concreteToolIndex]!.objective ?? plan.steps[concreteToolIndex]!.description}. Executar a listagem real via ToolRegistry.`,
    };
  }

  const normalizedToolIndex = concreteToolIndex;
  if (normalizedToolIndex === 0) {
    return plan;
  }

  const toolStep = normalizedToolIndex >= 0
    ? plan.steps[normalizedToolIndex]!
    : {
        id: "filesystem-request",
        index: 0,
        description: `Executar a operação filesystem solicitada: ${profile.text}`,
        objective: "Executar a ferramenta filesystem real antes de qualquer análise",
        capability: "execucao_ferramenta" as const,
        dependencies: [],
        status: "pending" as const,
        attempts: 0,
        maxAttempts: 3,
      };
  const remaining = plan.steps
    .filter((_, index) => index !== normalizedToolIndex)
    .slice(0, Math.max(0, maxPlanSteps - 1))
    .map((step, index) => ({
      ...step,
      index: index + 1,
      dependencies: [toolStep.id, ...step.dependencies.filter((dependency) => dependency !== toolStep.id)],
    }));

  return {
    ...plan,
    steps: [
      { ...toolStep, index: 0, dependencies: [] },
      ...remaining,
    ],
    nextStepId: toolStep.id,
  };
}

/**
 * Rede de segurança para o plano gerado pelo LLM: se a tarefa tem intenção de
 * filesystem CONFIRMADAMENTE read/list, nenhuma etapa "geracao_codigo" pode
 * sobreviver — mesmo que o LLM ignore a regra do prompt. Reclassifica para
 * "raciocinio" (texto explicativo, sem ferramenta) em vez de remover a etapa,
 * para não quebrar `dependencies` de outras etapas que apontem para ela.
 */
function stripCodeGenerationSteps(plan: Plan, profile: TaskProfile): Plan {
  if (profile.filesystemIntent !== "read" && profile.filesystemIntent !== "list") {
    return plan;
  }
  if (!plan.steps.some((step) => step.capability === "geracao_codigo")) {
    return plan;
  }
  return {
    ...plan,
    steps: plan.steps.map((step) =>
      step.capability === "geracao_codigo"
        ? { ...step, capability: "raciocinio" as const }
        : step
    ),
  };
}

function ensureWorkspaceInspectionStep(plan: Plan, profile: TaskProfile, maxPlanSteps: number): Plan {
  if (!isWorkspaceInspectionIntent(profile.text)) {
    return plan;
  }

  const existing = plan.steps.find(
    (step) => step.capability === "execucao_ferramenta" && /listar|list\b|filesystem\s+list/i.test(`${step.description} ${step.objective ?? ""}`)
  );
  if (existing) {
    return plan;
  }

  const step: PlanStep = {
    id: "workspace-inspection",
    index: 0,
    description: "Listar recursivamente a estrutura atual do workspace",
    objective: "Executar filesystem list na raiz do workspace e retornar a evidência estruturada",
    capability: "execucao_ferramenta",
    dependencies: [],
    status: "pending",
    attempts: 0,
    maxAttempts: 3,
  };
  const remaining = plan.steps.slice(0, Math.max(0, maxPlanSteps - 1)).map((current, index) => ({
    ...current,
    index: index + 1,
    dependencies: current.dependencies.includes(step.id)
      ? current.dependencies
      : [step.id, ...current.dependencies],
  }));

  return {
    ...plan,
    steps: [step, ...remaining],
    nextStepId: step.id,
  };
}

/**
 * Ordena capabilities para um plano lógico.
 */
function orderCapabilitiesForPlan(caps: TaskCapability[]): TaskCapability[] {
  const order: TaskCapability[] = [
    "analise",
    "planejamento",
    "geracao_codigo",
    "execucao_ferramenta",
    "validacao",
    "raciocinio",
    "conversa",
  ];

  return order.filter((cap) => caps.includes(cap));
}

/**
 * Descreve uma capability em linguagem natural.
 */
function describeCapability(cap: TaskCapability): string {
  switch (cap) {
    case "analise":
      return "Analisar o contexto e identificar problemas";
    case "planejamento":
      return "Planejar a abordagem de implementação";
    case "geracao_codigo":
      return "Implementar o código necessário";
    case "execucao_ferramenta":
      return "Executar a ação real necessária (arquivo, comando ou requisição) via ferramenta";
    case "validacao":
      return "Validar o resultado e verificar qualidade";
    case "raciocinio":
      return "Raciocinar sobre a tarefa e derivar conclusões";
    case "conversa":
      return "Responder à solicitação de conversa";
    default:
      return `Executar ${String(cap)}`;
  }
}
