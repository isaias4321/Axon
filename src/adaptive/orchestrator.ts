/**
 * Fase 5 — Multi-Agent Orchestrator.
 *
 * Quando a estratégia é `multi_agent`, o runtime (F4) hoje devolve um
 * placeholder apontando para a Fase 5. Este módulo preenche esse loop:
 * `runOrchestrated` decompõe a tarefa em **agentes especializados**
 * (execução sequencial com contexto acumulado) e sintetiza uma resposta
 * final coesa.
 *
 * Princípios herdados das fases anteriores:
 * - **Determinístico até o ponto de IO**: o plano de sub-tarefas vem do
 *   `TaskProfile` (F1), NUNCA de tool-calling do LLM. O único IO é o
 *   `LLMRunner` injetável (igual à F4).
 * - **Pipeline fixo**: rota canônica `analise → planejamento →
 *   geracao_codigo → validacao`; capacidades fora dessa rota
 *   (`raciocinio`, `conversa`) são filtradas. Menos chamadas sem perder a
 *   cobertura das capacidades reais.
 * - **Mínima inteligência por sub-tarefa**: o modelo de cada passo é
 *   resolvido por `routeModel` (F1–F2), nunca por "marca". Se nenhum
 *   modelo atende a capacidade, cai no modelo global da decisão.
 * - **Fail-open seletivo**: erro genérico de um passo vira
 *   `step.status="error"` e a execução continua; `ProviderHttpError`
 *   re-propaga (a rota mapeia 502).
 */

import { ProviderHttpError } from "../lib/retry.js";
import type { ProviderAdapter } from "../providers/types.js";
import type {
  ChatCompletionRequest,
  ChatMessage,
  ChatCompletionResponse,
} from "../schemas/chat.js";
import { estimateCostUsd, costPriceFor, type CostEstimate } from "./costEstimator.js";
import {
  estimateMessagesTokens,
  estimateTextTokens,
} from "./tokenEstimator.js";
import type { ModelEntry } from "./modelCatalog.js";
import { routeModel, type ModelDecision } from "./modelRouter.js";
import type { LLMRunner } from "./runtime.js";
import type { ScoringWeights } from "./scoring.js";
import type { StrategyDecision } from "./strategyEngine.js";
import type {
  TaskCapability,
  TaskCategory,
  TaskProfile,
} from "./taskAnalyzer.js";

/** Ordem canônica do pipeline — determina o fluxo de contexto acumulado. */
const SUBTASK_ORDER: readonly TaskCapability[] = [
  "analise",
  "planejamento",
  "geracao_codigo",
  "validacao",
];

/**
 * System prompt de cada agente especializado (pt-BR, determinístico).
 * Capacidades de fora do pipeline servem de fallback (ex: `raciocinio`
 * usada para passos sem rota); a síntese final tem seu próprio prompt.
 */
const SUBTASK_PROMPTS: Record<TaskCapability, string> = {
  analise:
    "Você é um agente especialista em ANÁLISE. Analise o contexto, aponte riscos e levante fatos concretos. Seja objetivo e técnico.",
  planejamento:
    "Você é um agente especialista em PLANEJAMENTO. Com base na análise e nas etapas anteriores, estruture um plano ordenado de implementação, com etapas e fases necessárias.",
  geracao_codigo:
    "Você é um agente especialista em GERAÇÃO DE CÓDIGO. Produza código claro, correto e pronto para uso que implemente o que o plano determina.",
  validacao:
    "Você é um agente especialista em VALIDAÇÃO. Revise o resultado anterior, aponte falhas, riscos e proponha correções objetivas.",
  raciocinio:
    "Você é um agente de RACIOCÍNIO. Deduza e fundamente conclusões a partir do contexto fornecido.",
  conversa:
    "Você é um agente de CONVERSA. Responda de forma clara, considerando o contexto acumulado.",
  execucao_ferramenta:
    "Você é um agente de EXECUÇÃO. Descreva de forma concreta e específica a ação real necessária (arquivo, comando ou requisição), incluindo caminho/conteúdo/comando exatos quando aplicável.",
};

const SYNTHESIS_SYSTEM_PROMPT =
  "Você é o agente ORCHESTRATOR. Consolide o resultado da tarefa original em uma resposta final coesa e acionável, sem inventar conteúdo. Liste etapas, decisões e recomendações quando aplicável.";

/** Categoria artificial usada no roteamento de uma sub-tarefa isolada. */
function categoryForCapability(capability: TaskCapability): TaskCategory {
  switch (capability) {
    case "geracao_codigo":
      return "codigo";
    case "analise":
    case "validacao":
    case "raciocinio":
      return "analise";
    case "planejamento":
      return "planejamento";
    case "conversa":
      return "conversacao";
    case "execucao_ferramenta":
      return "geral";
  }
}

export interface SubtaskPlan {
  index: number;
  capability: TaskCapability;
  label: string;
  prompt: string;
}

export type SubtaskStatus = "ok" | "error";

export interface OrchestrationStep {
  index: number;
  capability: TaskCapability;
  label: string;
  provider: string;
  model: string;
  status: SubtaskStatus;
  content: string | null;
  error: string | null;
  /** Ausente quando o passo não executou (mesmo padrão `undefined` do runtime). */
  usage: ChatCompletionResponse["usage"];
  estimation: CostEstimate;
  durationMs: number;
}

export interface OrchestrationCost {
  /** Modelo global escolhido por `routeModel` no runtime. */
  model: string;
  steps: OrchestrationStep[];
  totalTokens: number;
  /** `null` quando algum passo não tem preço no catálogo (compatível com F3). */
  totalCostUsd: number | null;
}

export interface OrchestrationReport {
  strategy: "multi_agent";
  /** Espelha o plano determinístico (rastreável). */
  subtasks: SubtaskPlan[];
  steps: OrchestrationStep[];
  synthesis: {
    provider: string;
    model: string;
    content: string;
    usage: ChatCompletionResponse["usage"];
    estimation: CostEstimate;
    durationMs: number;
  };
  cost: OrchestrationCost;
  /** Erro genérico fail-open do orchestrator; `null` quando executou. */
  error: string | null;
}

export interface OrchestrationOptions {
  runner?: LLMRunner;
  catalog?: readonly ModelEntry[];
  weights?: ScoringWeights;
  /** Callback opcional de progresso em tempo real (consumido por /v1/run em modo streaming). */
  onProgress?: import("./progress.js").ProgressEmitter;
}

/**
 * Decompõe o `TaskProfile` em sub-tarefas seguindo o pipeline fixo.
 * Determinístico: a decisão dos passos vem das capacidades da F1, nunca do
 * LLM. Capacidades fora do pipeline (`raciocinio`, `conversa`) não viram
 * passo próprio.
 */
export function planSubtasks(profile: TaskProfile): SubtaskPlan[] {
  const plans: SubtaskPlan[] = [];
  let index = 0;

  for (const capability of SUBTASK_ORDER) {
    if (profile.capabilities.includes(capability)) {
      plans.push({
        index,
        capability,
        label: capability,
        prompt: SUBTASK_PROMPTS[capability],
      });
      index += 1;
    }
  }

  return plans;
}

/**
 * Escolhe o menor modelo adequado para uma sub-tarefa (rota direta,
 * determinística). Fallback: o modelo global da decisão do runtime.
 */
export function routeForSubtask(
  capability: TaskCapability,
  profile: TaskProfile,
  providers: Map<string, ProviderAdapter>,
  fallbackProvider: string,
  fallbackModel: string,
  catalog?: readonly ModelEntry[],
  weights?: ScoringWeights
): { provider: string; model: string } {
  const subprofile: TaskProfile = {
    ...profile,
    capabilities: [capability],
    category: categoryForCapability(capability),
    hints: [`subtask:${capability}`],
  };

  const decision = routeModel(subprofile, "single_agent", providers, {
    catalog,
    weights,
  });

  if (
    decision.status === "ok" &&
    decision.provider !== null &&
    decision.model !== null
  ) {
    return { provider: decision.provider, model: decision.model };
  }

  // Fallback seguro: o modelo global já foi validado como executável.
  return { provider: fallbackProvider, model: fallbackModel };
}

function buildRequest(
  resolved: { provider: string; model: string },
  messages: ChatMessage[]
): ChatCompletionRequest {
  return {
    provider: resolved.provider as ChatCompletionRequest["provider"],
    model: resolved.model,
    messages,
    temperature: 0.7,
    max_tokens: 1024,
    stream: false,
    tool_choice: "none",
  };
}

/**
 * Estima o custo de UMA chamada como `CostEstimate` (F3): usa o `usage` real
 * quando presente, senão projeta pelos tokens das mensagens/saída. Preço do
 * catálogo; fora dele → `costUsd`/preços null.
 */
function buildCostEstimate(
  model: string,
  messages: readonly ChatMessage[],
  outputContent: string,
  usage: ChatCompletionResponse["usage"],
  catalog?: readonly ModelEntry[]
): CostEstimate {
  const price = costPriceFor(model, catalog);
  const inputTokens =
    usage?.prompt_tokens ?? estimateMessagesTokens(messages);
  const outputTokens =
    usage?.completion_tokens ?? estimateTextTokens(outputContent);

  return {
    model,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    costUsd: price ? estimateCostUsd(price, inputTokens, outputTokens) : null,
    inputCostPer1MTokens: price?.inputPer1M ?? null,
    outputCostPer1MTokens: price?.outputPer1M ?? null,
  };
}

async function callRunner(
  request: ChatCompletionRequest,
  providers: Map<string, ProviderAdapter>,
  runner: LLMRunner | undefined,
  label: string
): Promise<ChatCompletionResponse> {
  if (runner) {
    return runner.complete(request);
  }
  const adapter = providers.get(request.provider);
  if (!adapter) {
    throw new Error(
      `Provedor '${request.provider}' não configurado para '${label}'.`
    );
  }
  return adapter.complete(request);
}

/**
 * Executa um passo do pipeline com fail-open por passo. Erros genéricos viram
 * `status:"error"` (a execução continua); `ProviderHttpError` re-propaga — a
 * rota `/v1/run` mapeia para 502, como no runtime da F4.
 */
async function completeStep(
  subtask: SubtaskPlan,
  profile: TaskProfile,
  providers: Map<string, ProviderAdapter>,
  previousContext: readonly string[],
  resolved: { provider: string; model: string },
  options: OrchestrationOptions
): Promise<OrchestrationStep> {
  const { runner, catalog } = options;

  const userContent = [
    `Tarefa original:\n${profile.text}`,
    "Resultados anteriores:",
    previousContext.length > 0
      ? previousContext.join("\n\n")
      : "(ainda sem resultados)",
  ].join("\n\n");

  const messages: ChatMessage[] = [
    { role: "system", content: subtask.prompt },
    { role: "user", content: userContent },
  ];

  const request = buildRequest(resolved, messages);
  const start = performance.now();

  try {
    const result = await callRunner(request, providers, runner, subtask.label);

    const estimation = buildCostEstimate(
      result.model,
      messages,
      result.content,
      result.usage,
      catalog
    );

    return {
      index: subtask.index,
      capability: subtask.capability,
      label: subtask.label,
      provider: resolved.provider,
      model: result.model,
      status: "ok",
      content: result.content,
      error: null,
      usage: result.usage,
      estimation,
      durationMs: performance.now() - start,
    };
  } catch (error) {
    // Mesma regra do runtime F4: erro de PROVEDOR sobe (rota mapeia 502);
    // erro genérico é fail-open — o passo vira "error" e a execução segue.
    if (error instanceof ProviderHttpError) {
      throw error;
    }

    const estimation = buildCostEstimate(
      resolved.model,
      messages,
      "",
      undefined,
      catalog
    );

    return {
      index: subtask.index,
      capability: subtask.capability,
      label: subtask.label,
      provider: resolved.provider,
      model: resolved.model,
      status: "error",
      content: null,
      error: error instanceof Error ? error.message : String(error),
      usage: undefined,
      estimation,
      durationMs: performance.now() - start,
    };
  }
}

function tokensOfStep(step: OrchestrationStep): number {
  return (
    (step.usage?.prompt_tokens ?? step.estimation.inputTokens) +
    (step.usage?.completion_tokens ?? step.estimation.outputTokens ?? 0)
  );
}

/**
 * Executa a orquestração multi-agente de ponta a ponta e devolve o relatório.
 * Lança apenas `ProviderHttpError` (erro de provedor upstream); qualquer
 * outro erro vira `report.error` (fail-open).
 */
export async function runOrchestrated(
  task: string,
  profile: TaskProfile,
  strategy: StrategyDecision,
  decision: ModelDecision,
  providers: Map<string, ProviderAdapter>,
  options: OrchestrationOptions = {}
): Promise<OrchestrationReport> {
  const { runner, catalog, weights, onProgress } = options;

  // Multi_agent executa só com decisão válida — aqui `decision.status==="ok"`
  // é pré-condição garantida pelo runtime; proteção caso venha inválida.
  if (decision.provider === null || decision.model === null) {
    return {
      strategy: "multi_agent",
      subtasks: [],
      steps: [],
      synthesis: {
        provider: "",
        model: "",
        content: "",
        usage: undefined,
        estimation: buildCostEstimate("", [], "", undefined, catalog),
        durationMs: 0,
      },
      cost: { model: "", steps: [], totalTokens: 0, totalCostUsd: null },
      error: decision.reason,
    };
  }

  const subtasks = planSubtasks(profile);
  if (subtasks.length === 0) {
    return {
      strategy: "multi_agent",
      subtasks,
      steps: [],
      synthesis: {
        provider: decision.provider,
        model: decision.model,
        content: "",
        usage: undefined,
        estimation: buildCostEstimate(
          decision.model,
          [{ role: "user", content: task }],
          "",
          undefined,
          catalog
        ),
        durationMs: 0,
      },
      cost: {
        model: decision.model,
        steps: [],
        totalTokens: 0,
        totalCostUsd: null,
      },
      error:
        "Nenhuma sub-tarefa planejada a partir das capacidades desta tarefa complexa.",
    };
  }

  const steps: OrchestrationStep[] = [];
  const previousContext: string[] = [];

  for (const subtask of subtasks) {
    onProgress?.({
      phase: "orquestracao",
      detail: `Etapa: ${subtask.capability}`,
    });
    const resolved = routeForSubtask(
      subtask.capability,
      profile,
      providers,
      decision.provider,
      decision.model,
      catalog,
      weights
    );

    const step = await completeStep(
      subtask,
      profile,
      providers,
      previousContext,
      resolved,
      options
    );

    steps.push(step);

    if (step.status === "ok" && step.content) {
      previousContext.push(`${contextLabel(step.index, step.label)}:\n${step.content}`);
    } else {
      previousContext.push(
        `${contextLabel(step.index, step.label)}: (passo falhou: ${step.error ?? "erro desconhecido"})`
      );
    }
  }

  // Síntese final — uma chamada extra do agente orchestrator, sempre no
  // modelo global da decisão (é quem consolida a resposta).
  onProgress?.({ phase: "sintese", detail: "Consolidando a resposta final…" });
  const synthesisMessages: ChatMessage[] = [
    { role: "system", content: SYNTHESIS_SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        `Tarefa original:\n${profile.text}`,
        "Resultados dos agentes especializados:",
        previousContext.join("\n\n"),
      ].join("\n\n"),
    },
  ];

  const synthesisStart = performance.now();
  let synthesis:
    | { provider: string; model: string; content: string; usage: ChatCompletionResponse["usage"]; estimation: CostEstimate; durationMs: number };
  let reportError: string | null = null;

  try {
    const request = buildRequest(
      { provider: decision.provider, model: decision.model },
      synthesisMessages
    );
    const result = await callRunner(request, providers, runner, "síntese");

    synthesis = {
      provider: decision.provider,
      model: result.model,
      content: result.content,
      usage: result.usage,
      estimation: buildCostEstimate(
        result.model,
        synthesisMessages,
        result.content,
        result.usage,
        catalog
      ),
      durationMs: performance.now() - synthesisStart,
    };
  } catch (error) {
    if (error instanceof ProviderHttpError) {
      throw error;
    }
    synthesis = {
      provider: decision.provider,
      model: decision.model,
      content: "",
      usage: undefined,
      estimation: buildCostEstimate(
        decision.model,
        synthesisMessages,
        "",
        undefined,
        catalog
      ),
      durationMs: performance.now() - synthesisStart,
    };
    reportError = error instanceof Error ? error.message : String(error);
  }

  // Custo agregado dos passos (F3). `totalCostUsd` é `null` se algum passo
  // não tem preço no catálogo.
  const totalTokens = steps.reduce((sum, step) => sum + tokensOfStep(step), 0);
  const anyNullCost = steps.some((step) => step.estimation.costUsd === null);
  const totalCostUsd: number | null = anyNullCost
    ? null
    : steps.reduce(
        (sum, step) => sum + (step.estimation.costUsd ?? 0),
        0
      );

  return {
    strategy: "multi_agent",
    subtasks,
    steps,
    synthesis,
    cost: {
      model: decision.model,
      steps,
      totalTokens,
      totalCostUsd,
    },
    error: reportError,
  };
}

function contextLabel(index: number, label: string): string {
  return `[Passo ${index + 1} — ${label}]`;
}