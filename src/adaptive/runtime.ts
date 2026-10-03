/**
 * Fase 4, 5 & 6 — Agent Runtime (Execution Layer).
 *
 * `executeTask` é o elo entre o motor de decisão (F1–F2) e a execução real:
 * recebe uma tarefa em linguagem natural, decide estratégia + modelo
 * (`TaskAnalyzer → StrategyEngine → ModelRouter`, igual ao `/v1/decide`),
 * e EXECUTA via o adapter do provedor — devolvendo um relatório completo
 * (`AgentRunReport`) com decisão, execução, custo projetado (F3) e custo
 * real.
 *
 * O ponto de IO é isolado atrás de `LLMRunner` (injetável — testes usam um
 * fake 100% offline). A camada é FAIL-OPEN: falha de execução vira
 * `execution.error`, nunca exceção propagada.
 */

import type { ProviderAdapter } from "../providers/types.js";
import { ProviderHttpError } from "../lib/retry.js";
import type { ProgressEmitter } from "./progress.js";
import { buildCandidateList, completeWithFallback } from "./providerFallback.js";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
} from "../schemas/chat.js";
import {
  costPriceFor,
  estimateCostUsd,
  type CostEstimate,
} from "./costEstimator.js";
import type { ModelEntry } from "./modelCatalog.js";
import { estimateTaskCost } from "./costEstimator.js";
import type { SessionMemoryStore, MemoryTurn } from "./memory.js";
import {
  runOrchestrated,
  type OrchestrationReport,
} from "./orchestrator.js";
import {
  runAutonomous,
  type AutonomousReport,
  type AutonomousBudgets,
} from "./autonomous.js";
import {
  routeModel,
  type ModelDecision,
  type ModelOverride,
} from "./modelRouter.js";
import type { ScoringWeights } from "./scoring.js";
import {
  decideStrategy,
  type Strategy,
  type StrategyDecision,
} from "./strategyEngine.js";
import { analyzeTask, type TaskProfile } from "./taskAnalyzer.js";
import { runProjectScaffold, type ProjectScaffoldReport } from "./projectScaffold.js";
import { buildArtifactContextBlock } from "./artifacts.js";
import {
  estimateMessagesTokens,
  estimateTextTokens,
} from "./tokenEstimator.js";

/** Executor da chamada ao LLM — injetável (testes usam fake). */
export interface LLMRunner {
  complete(request: ChatCompletionRequest, signal?: AbortSignal, timeoutMs?: number): Promise<ChatCompletionResponse>;
}

export interface RunExecution {
  executed: boolean;
  strategy: Strategy;
  content: string | null;
  /** Ausente quando não executou — usa `undefined` (schema rejeita null). */
  usage: ChatCompletionResponse["usage"];
  error: string | null;
}

export interface AgentRunReport {
  taskProfile: TaskProfile;
  strategy: StrategyDecision;
  decision: ModelDecision;
  execution: RunExecution;
  /** F3 — projeção offline (só input) do request. */
  estimation: CostEstimate | null;
  /** F3 — custo real (usage do provedor) quando executou; null senão. */
  costActual: CostEstimate | null;
  durationMs: number | null;
  /** Fase 5 — presente SÓ quando o `multi_agent` foi orquestrado/executado. */
  orchestration?: OrchestrationReport;
  /** Fase 6 — presente SÓ quando o `autonomous` foi executado. */
  autonomous?: AutonomousReport;
  /**
   * Presente SÓ quando a tarefa foi roteada para o caminho dedicado de
   * scaffold de projeto (ver projectScaffold.ts) — "monte um projeto e me
   * entregue", que gera múltiplos arquivos reais via uma chamada
   * estruturada ao LLM em vez do loop autônomo genérico por etapas.
   */
  projectScaffold?: ProjectScaffoldReport;
}

export interface ExecuteTaskOptions {
  /** Default: chama `adapter.complete` do provedor decidido. */
  runner?: LLMRunner;
  sessionStore?: SessionMemoryStore;
  sessionId?: string;
  /** Grava o turno na memória (default true). */
  memoryTurn?: boolean;
  catalog?: readonly ModelEntry[];
  weights?: ScoringWeights;
  override?: ModelOverride;
  budgets?: Partial<AutonomousBudgets>;
  /** Fase 6: permite desabilitar persistência SQLite em testes/execuções efêmeras. */
  persistAutonomousMemory?: boolean;
  /** Fase 7: sinal AbortController para cancelamento timeout global. */
  signal?: AbortSignal;
  /** Callback opcional de progresso em tempo real (consumido por /v1/run em modo streaming). */
  onProgress?: ProgressEmitter;
}

/**
 * Fase 4 (correção): monta o texto que vai para o LLM incluindo o histórico
 * recente da sessão. Antes desta função, `sessionStore.recall()` nunca era
 * chamado em NENHUM lugar do código — a sessão só GRAVAVA turnos
 * (`sessionStore.remember`), nunca os LIA de volta. Resultado: cada chamada
 * ao agente era, na prática, 100% sem memória de turnos anteriores — se o
 * usuário mandava um arquivo numa mensagem e pedia outra coisa na próxima,
 * o LLM via só a mensagem nova, sem nenhuma pista de que um arquivo já
 * tinha sido enviado antes.
 *
 * IMPORTANTE: isso NUNCA deve ser usado para `analyzeTask()`/classificação —
 * só para o texto que efetivamente vai para dentro do prompt do LLM (o
 * `task` passado a `runAutonomous`/`runOrchestrated`/single_agent). Misturar
 * histórico na classificação por regex já causou um bug real antes (um
 * texto de contexto injetado foi mal interpretado como parte do pedido
 * atual) — os dois ficam deliberadamente separados.
 */
function buildTaskWithHistory(task: string, history: readonly MemoryTurn[], artifactContextBlock: string): string {
  if ((!history || history.length === 0) && !artifactContextBlock) return task;

  // Limite adicional de segurança (além do FIFO de 10 turnos do próprio
  // store) para não deixar o prompt crescer demais em sessões longas.
  const recent = history.slice(-8);
  const transcript = recent
    .map((turn) => `${turn.role === "user" ? "Usuário" : "Assistente"}: ${turn.content}`)
    .join("\n");

  const historyBlock =
    recent.length > 0
      ? "Histórico recente desta conversa (contexto — NÃO responda a essas mensagens antigas, " +
        "responda apenas à mensagem atual do usuário, mas USE esse histórico para saber de " +
        `arquivos já mencionados, preferências e o que já foi dito):\n${transcript}\n\n`
      : "";

  // Bloco DETERMINÍSTICO (lido do SQLite via artifacts.ts, nunca adivinhado
  // pelo LLM) descrevendo qual arquivo/projeto é "o atual" nesta sessão —
  // resolve referências como "esse zip"/"o projeto atual"/"como eu executo
  // isso" sem depender do modelo reconstruir isso a partir do texto cru do
  // histórico acima (que nem sempre menciona o caminho exato do arquivo).
  const artifactBlock = artifactContextBlock ? `${artifactContextBlock}\n\n` : "";

  return `${artifactBlock}${historyBlock}Mensagem atual do usuário: ${task}`;
}

/**
 * Executa a tarefa de ponta a ponta. 100% determinístico até o ponto de IO
 * (a execução em si), depois fail-open.
 */
export async function executeTask(
  task: string,
  providers: Map<string, ProviderAdapter>,
  options: ExecuteTaskOptions = {}
): Promise<AgentRunReport> {
  const { runner, sessionStore, sessionId, signal, onProgress } = options;
  const memoryTurn = options.memoryTurn ?? true;

  // Fase 7: configurar timeout global via AbortController
  const abortController = signal ? { signal } : undefined;

  onProgress?.({ phase: "analise", detail: "Analisando a tarefa…" });
  // Classificação roda SEMPRE sobre o texto CRU da mensagem atual — ver o
  // comentário em buildTaskWithHistory sobre por que os dois não se misturam.
  const profile = analyzeTask(task);
  const strategy = decideStrategy(profile);
  const decision = routeModel(profile, strategy.strategy, providers, {
    catalog: options.catalog,
    weights: options.weights,
    override: options.override,
  });
  onProgress?.({
    phase: "decisao",
    detail:
      decision.provider && decision.model
        ? `Estratégia: ${strategy.strategy} · modelo: ${decision.provider}/${decision.model}`
        : `Estratégia: ${strategy.strategy} · ${decision.reason ?? "sem modelo disponível"}`,
  });

  // Duas fontes de contexto, independentes uma da outra:
  // - `sessionStore` (histórico de turnos em texto) exige um store configurado;
  // - o bloco de artefatos (SQLite, via artifacts.ts) só precisa de um sessionId,
  //   funciona mesmo sem sessionStore.
  const history = sessionId && sessionStore ? sessionStore.recall(sessionId) : [];
  const artifactBlock = sessionId ? buildArtifactContextBlock(sessionId) : "";
  const taskForLLM = history.length > 0 || artifactBlock ? buildTaskWithHistory(task, history, artifactBlock) : task;

  const estimation = estimateTaskCost(decision.model, task, options.catalog);

  const start = performance.now();
  // Override (provider/modelo) é o escape hatch: mesmo numa estratégia que
  // não executa por padrão (multi_agent/autonomous), o usuário que força um provider/
  // modelo quer EXECUTAR agora — o runtime respeita isso.
  const forceExecution =
    options.override?.provider !== undefined ||
    options.override?.model !== undefined;

  const { execution, orchestration, autonomous, projectScaffold } = await executeForStrategy(
    profile,
    strategy,
    decision,
    providers,
    {
      runner,
      forceExecution,
      taskForLLM,
      catalog: options.catalog,
      weights: options.weights,
      budgets: options.budgets,
      sessionId: options.sessionId,
      persistAutonomousMemory: options.persistAutonomousMemory,
      signal: abortController?.signal,
      onProgress,
    }
  );
  onProgress?.({
    phase: "concluido",
    detail: execution.executed ? "Execução concluída." : `Não executou: ${execution.error ?? "motivo desconhecido"}`,
  });
  const durationMs = execution.executed ? performance.now() - start : null;

  // `execution.executed` implica `decision.status === "ok"` → modelo não-nulo.
  const costActual =
    execution.executed && decision.model !== null
      ? costActualFromUsage(
          decision.model,
          profile.text,
          execution.content ?? "",
          execution.usage,
          options.catalog
        )
      : null;

  // Memória short-term: grava o turno user (e o assistant sempre que houver
  // conteúdo de resposta, mesmo quando `execution.executed` é `false`).
  // IMPORTANTE: antes exigia `execution.executed === true`, mas isso não
  // batia com o fallback do loop autônomo (no_progress) — que sintetiza uma
  // resposta honesta e ÚTIL a partir do que foi descoberto (ex.: o
  // conteúdo de um .zip listado) mesmo quando o `stopReason` final não é
  // "success". O usuário via essa resposta na tela (após a correção em
  // formatReportResponse no frontend), mas ela nunca era salva na memória
  // da sessão — então no turno seguinte o agente não lembrava de nada do
  // que tinha acabado de descobrir/responder.
  if (memoryTurn && sessionId && sessionStore) {
    sessionStore.remember(sessionId, { role: "user", content: task });
    if (execution.content) {
      sessionStore.remember(sessionId, {
        role: "assistant",
        content: execution.content,
      });
    }
  }

  const report: AgentRunReport = {
    taskProfile: profile,
    strategy,
    decision,
    execution,
    estimation,
    costActual,
    durationMs,
  };

  // Fase 5: anexa o relatório de orquestração só quando o multi_agent foi executado
  if (execution.strategy === "multi_agent" && orchestration) {
    report.orchestration = orchestration;
  }

  // Fase 6: anexa o relatório de autonomia só quando o autonomous foi executado
  if (execution.strategy === "autonomous" && autonomous) {
    report.autonomous = autonomous;
  }

  // Scaffold de projeto: anexa o relatório só quando o caminho dedicado foi usado
  if (projectScaffold) {
    report.projectScaffold = projectScaffold;
  }

  return report;
}

/**
 * Decide se executa e monta `RunExecution`.
 * Inclui loop de fallback sobre rankedCandidates quando o provedor
 * primário falha com erro transitivo (503/UNAVAILABLE, 502/BAD_GATEWAY, 429/RATE_LIMIT).
 */
async function executeForStrategy(
  profile: TaskProfile,
  strategy: StrategyDecision,
  decision: ModelDecision,
  providers: Map<string, ProviderAdapter>,
  options: {
    runner?: LLMRunner;
    forceExecution?: boolean;
    /** Texto com histórico de sessão embutido (ver buildTaskWithHistory) —
     *  usado no lugar de `profile.text` em toda chamada real ao LLM, para
     *  que o modelo tenha memória da conversa. Cai de volta a `profile.text`
     *  quando ausente (sem sessionId/sessionStore configurados). */
    taskForLLM?: string;
    catalog?: readonly ModelEntry[];
    weights?: ScoringWeights;
    budgets?: Partial<AutonomousBudgets>;
    sessionId?: string;
    persistAutonomousMemory?: boolean;
    signal?: AbortSignal;
    onProgress?: ProgressEmitter;
  }
): Promise<{
  execution: RunExecution;
  orchestration?: OrchestrationReport;
  autonomous?: AutonomousReport;
  projectScaffold?: ProjectScaffoldReport;
}> {
  const taskForLLM = options.taskForLLM ?? profile.text;

  if (decision.status !== "ok" || decision.provider === null || decision.model === null) {
    return {
      execution: {
        executed: false,
        strategy: strategy.strategy,
        content: null,
        usage: undefined,
        error: decision.reason,
      },
    };
  }

  if (strategy.strategy === "no_execution") {
    return {
      execution: {
        executed: false,
        strategy: "no_execution",
        content: null,
        usage: undefined,
        error: strategy.reason,
      },
    };
  }

  // Fase 6: Autonomous Loop SEM override
  if (strategy.strategy === "autonomous" && !options.forceExecution) {
    // "Monte um projeto e me entregue" tem um caminho de execução dedicado
    // (ver o comentário no topo de projectScaffold.ts) em vez do loop
    // autônomo genérico por etapas, que é estruturalmente inadequado para
    // gerar múltiplos arquivos de código reais a partir de descrições
    // curtas re-interpretadas por regex.
    if (profile.toolIntent === "project") {
      const scaffold = await runProjectScaffold(taskForLLM, decision, providers, {
        runner: options.runner,
        onProgress: options.onProgress,
        signal: options.signal,
        sessionId: options.sessionId,
      });

      return {
        execution: {
          executed: scaffold.executed,
          strategy: "autonomous",
          content: scaffold.content,
          usage: undefined,
          error: scaffold.error,
        },
        projectScaffold: scaffold,
      };
    }

    const autonomous = await runAutonomous(
      taskForLLM,
      profile,
      strategy,
      decision,
      providers,
      {
        runner: options.runner,
        catalog: options.catalog,
        weights: options.weights,
        budgets: options.budgets,
        sessionId: options.sessionId,
        persistMemory: options.persistAutonomousMemory,
        signal: options.signal,
        onProgress: options.onProgress,
      }
    );

    // `executed: true` deve refletir se a tarefa foi REALMENTE concluída
    // (stopReason === "success"), não apenas "existe algum texto em
    // finalResult". Antes, um loop que desistia por no_progress/
    // max_iterations ainda podia ter `finalResult` preenchido com a saída
    // da ÚLTIMA etapa que passou validação (não necessariamente a tarefa
    // toda) — isso fazia `executed` virar `true` com `error` preenchido ao
    // mesmo tempo, um estado contraditório que o frontend/SSE reportava
    // como "✅ Concluído" mesmo quando o agente desistiu sem terminar.
    const genuinelySucceeded = autonomous.stopReason === "success";

    if (!genuinelySucceeded && !autonomous.finalResult) {
      return {
        execution: {
          executed: false,
          strategy: "autonomous",
          content: null,
          usage: undefined,
          error: autonomous.error,
        },
        autonomous,
      };
    }

    return {
      execution: {
        executed: genuinelySucceeded,
        strategy: "autonomous",
        content: autonomous.finalResult,
        usage: undefined, // Uso é agregado nos logs dos passos
        error: autonomous.error,
      },
      autonomous,
    };
  }

  // multi_agent SEM override executa o Orchestrator (Fase 5) — com verificação de abort
  if (strategy.strategy === "multi_agent" && !options.forceExecution) {
    // Verificar se houve abort antes de iniciar
    if (options.signal?.aborted) {
      return {
        execution: {
          executed: false,
          strategy: "multi_agent",
          content: null,
          usage: undefined,
          error: "Execução cancelada (timeout/global abort)",
        },
      };
    };
    const orchestration = await runOrchestrated(
      taskForLLM,
      profile,
      strategy,
      decision,
      providers,
      { runner: options.runner, catalog: options.catalog, weights: options.weights, onProgress: options.onProgress }
    );

    if (orchestration.error !== null) {
      return {
        execution: {
          executed: false,
          strategy: "multi_agent",
          content: null,
          usage: undefined,
          error: orchestration.error,
        },
        orchestration: undefined,
      };
    }

    return {
      execution: {
        executed: true,
        strategy: "multi_agent",
        content: orchestration.synthesis.content,
        usage: orchestration.synthesis.usage,
        error: null,
      },
      orchestration,
    };
  }

  // Fallback real sobre rankedCandidates (F2): se o provedor/modelo
  // primário falhar com erro RECUPERÁVEL (503/UNAVAILABLE, 502/BAD_GATEWAY,
  // 429/RATE_LIMIT, 404/model_not_found), tenta o próximo candidato do
  // ranking antes de desistir. Lógica compartilhada em providerFallback.ts
  // — usada também pelo loop autônomo (planner/executor/validator).
  const candidates = buildCandidateList(
    decision.provider,
    decision.model,
    decision.rankedCandidates,
    providers
  );

  try {
    const { response, usedProvider, usedModel } = await completeWithFallback(
      (candidate) => ({
        provider: candidate.provider as ChatCompletionRequest["provider"],
        model: candidate.model,
        messages: [{ role: "user", content: taskForLLM }],
        temperature: 0.7,
        max_tokens: 1024,
        stream: false,
        tool_choice: "none",
      }),
      providers,
      candidates,
      { runner: options.runner, signal: options.signal, onProgress: options.onProgress }
    );

    // Reflete o que de fato executou (pode diferir do candidato primário
    // se houve fallback) no relatório final e no cálculo de custo real.
    decision.provider = usedProvider;
    decision.model = usedModel;

    return {
      execution: {
        executed: true,
        strategy: "single_agent",
        content: response.content,
        usage: response.usage,
        error: null,
      },
    };
  } catch (error) {
    if (error instanceof ProviderHttpError) {
      throw error;
    }
    return {
      execution: {
        executed: false,
        strategy: "single_agent",
        content: null,
        usage: undefined,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/**
 * Custo real do request executado
 */
function costActualFromUsage(
  model: string,
  inputText: string,
  outputContent: string,
  usage: ChatCompletionResponse["usage"],
  catalog?: readonly ModelEntry[]
): CostEstimate {
  const price = costPriceFor(model, catalog);
  const inputTokens =
    usage?.prompt_tokens ?? estimateMessagesTokens([{ role: "user", content: inputText }]);
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
