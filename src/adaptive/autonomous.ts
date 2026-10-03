/**
 * Fase 6 — Autonomous Behavior Engine (Refatorado).
 *
 * Implementa o ciclo iterativo autônomo adaptativo:
 *
 * TASK → MEMORY RETRIEVAL → PLANNER → BUDGET CHECK →
 * LOOP (select step → EXECUTE ONE STEP → OBSERVE → VALIDATE → DECIDE) →
 * EPISODIC MEMORY
 *
 * Componentes (separados, baixo acoplamento):
 * - MemoryRetrieval: recupera experiências relevantes antes do planejamento
 * - Planner: gera plano estruturado baseado na tarefa real
 * - BudgetManager: enforça limites de iterations/cost/duration/toolCalls/tokens
 * - Executor: executa UMA etapa por vez via LLM ou Tool
 * - Observer: transforma resultado bruto em Observation estruturada
 * - Validator: validação híbrida (heurísticas + Critic LLM)
 * - DecisionEngine: decide CONTINUE/CORRECT/REPLAN/FINISH
 * - ProgressTracker: detecta falta de progresso + observabilidade
 * - EpisodicMemory: persiste episódio completo + lessons learned
 *
 * Princípios herdados das Fases 1–5:
 * - 100% determinístico até o ponto de IO (LLMRunner/ProviderAdapter injetáveis)
 * - Fail-open: erros não-LLM não quebram a execução
 * - Reutiliza TaskAnalyzer, StrategyEngine, ModelRouter, CostEstimator
 * - Memória SQLite para persistência de longo prazo
 */

import { ProviderHttpError } from "../lib/retry.js";
import type { ProviderAdapter } from "../providers/types.js";
import type { ChatCompletionRequest, ChatCompletionResponse } from "../schemas/chat.js";
import {
  episodesRepo,
  initializeDatabase,
} from "../lib/db/index.js";
import type { ModelEntry } from "./modelCatalog.js";
import type { LLMRunner } from "./runtime.js";
import type { ScoringWeights } from "./scoring.js";
import type { FallbackCandidate } from "./providerFallback.js";
import type { StrategyDecision } from "./strategyEngine.js";
import { type TaskProfile, type TaskCapability, detectToolIntent } from "./taskAnalyzer.js";
import type { AutonomousBudgets, Plan, PlanStep, AutonomousConfig, CycleLog, ValidationResult, TerminationReason, CorrectionRecord, ReplanRecord, Strategy } from "./types.js";
import type { EpisodeData } from "./episodicMemory.js";

// Fase 7 — Self Evolution Layer imports
import {
  createCuriosityState,
  detectCuriosity,
  type CuriositySignal,
} from "../evolution/curiosity.js";
import { generateGoals, type Goal } from "../evolution/goals.js";
import { createMetabolismState } from "../evolution/metabolism.js";
import {
  createSkillsState,
  updateSkill,
} from "../evolution/skills.js";
import { createStrategyState, recordStrategyOutcome } from "../evolution/strategy.js";
import { reflect, saveReflection } from "../evolution/reflection.js";
import {
  loadEvolutionContext,
  emptyEvolutionContext,
  influenceModelTier,
  type EvolutionContext,
} from "../evolution/loader.js";

// Re-export para compatibilidade com runtime.ts
export type { AutonomousBudgets } from "./types.js";
import { BudgetManager } from "./budget.js";
import { retrieveRelevantMemory, type RetrievedMemory } from "./memoryRetrieval.js";
import type { ProgressEmitter } from "./progress.js";
import { planTask } from "./planner.js";
import { executeOneStep } from "./executor.js";
import { validateStep } from "./validator.js";
import { decideNextAction, applyCorrection, replan } from "./decision.js";
import { saveEpisode } from "./episodicMemory.js";
import { buildCandidateList, completeWithFallback } from "./providerFallback.js";
import {
  createDefaultToolRegistry,
  getWorkspaceRoot,
  type ToolRegistry,
  type ToolRegistryOptions,
} from "./tools/registry.js";
import {
  createProgressState,
  detectNoProgress,
  recordCycle,
  hashToolInput,
} from "./progressTracker.js";

// Fase 9 — Cognitive Cells integration (opt-in, fail-open).
import { recoverWithCell } from "../cognitive/agentAdapter.js";
import { getDefaultLogger } from "../lib/logger.js";
import { registerArtifactsFromObservation } from "./artifacts.js";

/** Condições de encerramento do loop autônomo (compatibilidade). */
export type AutonomousStopReason = TerminationReason;

/** Limites de orçamento e segurança para a execução autônoma. */
export const DEFAULT_AUTONOMOUS_BUDGETS: AutonomousBudgets = {
  maxIterations: 10,
  maxCostUsd: 0.10,
  maxDurationMs: 60000,
  maxToolCalls: 20,
  maxTokens: 50000,
};

/** Estrutura do Plano de Ação Autônomo (compatibilidade com testes). */
export interface ActionPlanStep {
  id?: string;
  index: number;
  description: string;
  objective?: string;
  capability: TaskCapability;
  dependencies?: string[];
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  attempts?: number;
  result?: string;
  validation?: string;
}

/** Validação Híbrida (compatibilidade). */
export interface HeuristicResult {
  passed: boolean;
  issues: string[];
}

export interface CriticResult {
  passed: boolean;
  confidence: number;
  issues: string[];
  suggestedCorrection: string | null;
  usage?: ChatCompletionResponse["usage"];
  model?: string;
  estimation?: unknown;
}

export interface ValidationReport {
  passed: boolean;
  heuristic: HeuristicResult;
  critic: CriticResult | null;
}

/** Um passo individual do ciclo autônomo (compatibilidade). */
export interface AutonomousStepLog {
  iteration: number;
  planStepIndex: number;
  capability: TaskCapability;
  actionDescription: string;
  provider: string;
  model: string;
  outputContent: string | null;
  error: string | null;
  validation: ValidationReport;
  nextDecision: "continue" | "correct" | "replan" | "finish";
  usage?: ChatCompletionResponse["usage"];
  estimation: unknown;
  durationMs: number;
}

/** Relatório Final de Execução Autônoma (compatibilidade). */
export interface AutonomousReport {
  strategy: "autonomous";
  stopReason: AutonomousStopReason;
  iterations: number;
  plan: ActionPlanStep[];
  stepLogs: AutonomousStepLog[];
  finalResult: string | null;
  totalTokens: number;
  totalCostUsd: number | null;
  totalDurationMs: number;
  episodeId: number | null;
  error: string | null;
}

export interface AutonomousOptions {
  runner?: LLMRunner;
  catalog?: readonly ModelEntry[];
  weights?: ScoringWeights;
  budgets?: Partial<AutonomousBudgets>;
  sessionId?: string;
  persistMemory?: boolean;
  /** Sinal AbortController para timeout global — aborta o loop a cada iteração. */
  signal?: AbortSignal;
  /** Callback opcional de progresso em tempo real (consumido por /v1/run em modo streaming). */
  onProgress?: import("./progress.js").ProgressEmitter;
  /** ToolRegistry para execução de ações reais. */
  toolRegistry?: ToolRegistry;
  /** Opções de segurança para o ToolRegistry. */
  toolSecurity?: ToolRegistryOptions["security"];
  /** Configuração avançada da Fase 6. */
  config?: Partial<AutonomousConfig>;
  /**
   * Fase 9 — integração opt-in com Cognitive Cells (Validation/Recovery).
   * Quando false (default), o loop é 100% o fluxo F6/F7. Quando true e uma
   * célula falha, o loop segue o comportamento padrão (fail-open).
   */
  cognitive?: {
    enabled?: boolean;
    recoveryCell?: import("../cognitive/types.js").CognitiveCell;
    validationCell?: import("../cognitive/types.js").CognitiveCell;
    maxRecoveryAttempts?: number;
  };
}

/**
 * Resultado do planejamento LLM (compatibilidade).
 */
export interface PlannerResult {
  steps: ActionPlanStep[];
  fallbackUsed: boolean;
}

/**
 * Loop Autônomo Principal (Fase 6 Refatorado).
 */
export async function runAutonomous(
  task: string,
  profile: TaskProfile,
  _strategy: StrategyDecision,
  decision: {
    provider: string | null;
    model: string | null;
    /** Ranking do F2 — usado como cadeia de fallback (ver providerFallback.ts).
     * Opcional para não quebrar quem já chama runAutonomous sem esse campo. */
    rankedCandidates?: readonly FallbackCandidate[];
  },
  providers: Map<string, ProviderAdapter>,
  options: AutonomousOptions = {}
): Promise<AutonomousReport> {
  const budgets: AutonomousBudgets = { ...DEFAULT_AUTONOMOUS_BUDGETS, ...options.budgets };
  const {
    runner,
    catalog,
    weights,
    sessionId = "default_session",
    persistMemory = true,
    toolRegistry,
    toolSecurity,
    config,
    signal,
    onProgress,
  } = options;

  const startTime = Date.now();

  // Configuração
  const autonomousConfig: AutonomousConfig = {
    budgets,
    enableMemoryRetrieval: config?.enableMemoryRetrieval ?? true,
    enableCritic: config?.enableCritic ?? true,
    enableReplanning: config?.enableReplanning ?? true,
    enableCorrection: config?.enableCorrection ?? true,
    noProgressThreshold: config?.noProgressThreshold ?? 3,
    criticModel: config?.criticModel ?? decision.model ?? undefined,
    maxPlanSteps: config?.maxPlanSteps ?? 10,
  };

  // Verificação inicial: provider/modelo
  if (decision.provider === null || decision.model === null) {
    return {
      strategy: "autonomous",
      stopReason: "failure",
      iterations: 0,
      plan: [],
      stepLogs: [],
      finalResult: null,
      totalTokens: 0,
      totalCostUsd: null,
      totalDurationMs: 0,
      episodeId: null,
      error: decision.provider === null ? "No provider available" : "No model available",
    };
  }

  // 1. Inicializar Banco SQLite
  let episodeId: number | null = null;
  if (persistMemory) {
    try {
      initializeDatabase();
      const episode = episodesRepo.create({
        session_id: sessionId,
        task,
        strategy: "autonomous",
      });
      episodeId = episode.id;
    } catch {
      // Ignora erro de DB
    }
  }

  // 2. Memory Retrieval (antes do planejamento)
  let retrievedMemory: RetrievedMemory[] = [];
  if (autonomousConfig.enableMemoryRetrieval) {
    const result = retrieveRelevantMemory(task, profile);
    retrievedMemory = result.memories;
  }

  // 3. Planner (gera plano estruturado)
  const plannerResult = await planTask(
    task,
    profile,
    runner,
    providers,
    decision.provider,
    decision.model,
    retrievedMemory,
    autonomousConfig.maxPlanSteps,
    decision.rankedCandidates ?? [],
    onProgress
  );

  const plan: Plan = plannerResult.plan;

  // 4. Budget Manager
  const budgetManager = new BudgetManager(budgets, startTime);

  // 5. Progress Tracker
  const progressState = createProgressState();

  // 6. Tool Registry (se não fornecido, cria um padrão)
  const registry =
   toolRegistry ??
  createDefaultToolRegistry({
    security: toolSecurity?.fsRoot
      ? toolSecurity
      : { ...(toolSecurity ?? {}), fsRoot: getWorkspaceRoot() },
  });

  // 7. Estado de execução
  let iteration = 0;
  let stopReason: AutonomousStopReason;
  let finalResult: string | null = null;
  let accumulatedCostUsd = 0;
  let accumulatedTokens = 0;
  let consecutiveFailures = 0;

  const stepLogs: AutonomousStepLog[] = [];
  const cycleLogs: CycleLog[] = [];

  // 8. Fase 7 — Self Evolution State (em memória, carregado do DB se persistMemory)
  const curiosityState = createCuriosityState();
  let curiositySignal: CuriositySignal = { shouldExplore: false, reason: "", priority: 0, suggestedKnowledge: "" };
  const goals: Goal[] = [];
  const skillsState = createSkillsState();
  const metabolismState = createMetabolismState();
  const strategyState = createStrategyState();
  const accumulatedContext: string[] = [];
  const corrections: CorrectionRecord[] = [];
  const replans: ReplanRecord[] = [];

  // Fase 7 — CARREGA histórico evolutivo do SQLite (fecha o feedback loop).
  // Fail-open: se o load falhar, usa contexto vazio — nunca derruba o loop.
  const evolutionContext: EvolutionContext = persistMemory
    ? loadEvolutionContext(sessionId)
    : emptyEvolutionContext();

  // Hidrata estados em memória a partir do contexto carregado
  // (skills/strategy são usados para influenciar decisões abaixo).
  for (const s of evolutionContext.skills) {
    updateSkill(skillsState, s.name as TaskCapability, s.successRate >= 0.5, `[hist] ${s.name}`);
  }
  for (const st of evolutionContext.strategyHistory) {
    recordStrategyOutcome(
      strategyState,
      st.strategy as Strategy,
      st.successRate >= 0.5,
      st.avgCost,
      st.avgTime
    );
  }
  // Reflexões anteriores enriquecem o contexto dos próximos passos:
  // o loop começa "ciente" das lições aprendidas em execuções passadas.
  for (const lesson of evolutionContext.priorReflections) {
    if (lesson) {
      accumulatedContext.push(`[Aprendizado anterior]: ${lesson}`);
    }
  }
  // Capacidades fracas do histórico alimentam a curiosidade logo no início.
  if (evolutionContext.skills.length > 0) {
    const weak = evolutionContext.skills
      .filter((s) => s.usageCount >= 3 && s.successRate < 0.5)
      .map((s) => s.name);
    if (weak.length > 0) {
      curiosityState.signalHistory.set(
        `hist:${weak.join(",")}`,
        (curiosityState.signalHistory.get(`hist:${weak.join(",")}`) ?? 0) + 1
      );
    }
  }

  // Fase 8 — o histórico evoluído INFLUENCIA A ESCOLHA DE MODELO.
  // `influenceModelTier` lê a energia histórica e sugere um tier; ajustamos os
  // pesos de scoring para favorecer modelos baratos (ou caros) conforme o risco
  // aprendido. Assim o F7 muda uma decisão REAL (modelo escolhido por etapa).
  const tierInfluence = influenceModelTier(evolutionContext, "balanced");
  const evolvedWeights: ScoringWeights | undefined = weights
    ? {
        ...weights,
        // Tier "cheap" → penaliza custo (peso maior); "expensive" → prioriza capacidade.
        cost: tierInfluence.tier === "cheap" ? weights.cost + 0.2 : weights.cost,
        capability: tierInfluence.tier === "expensive" ? weights.capability + 0.2 : weights.capability,
      }
    : undefined;
  // O LOOP AUTÔNOMO
  let currentPlan = plan;

  while (true) {
    // Timeout global (Fase de resiliência): se o sinal externo indicar abort,
    // o loop encerra com status de timeout — em vez de cair em `max_iterations`
    // por um cancelamento externo que não é um ciclo natural do orçamento.
    if (signal?.aborted) {
      stopReason = "timeout";
      break;
    }

    // Reconhece o plano concluído antes de consultar o limite de iterações.
    // A última etapa pode consumir exatamente maxIterations; nesse caso não
    // existe uma nova ação para bloquear e o resultado correto é sucesso.
    const currentStep = selectNextStep(currentPlan);
    if (!currentStep) {
      stopReason = currentPlan.steps.length > 0 && currentPlan.steps.every((step) => step.status === "completed")
        ? "success"
        : "failure";
      if (stopReason === "success") {
        const lastByIndex = [...currentPlan.steps].sort((a, b) => b.index - a.index)[0];
        finalResult = buildEvidenceCompleteFinalResult(
          finalResult,
          accumulatedContext,
          lastByIndex?.capability === "execucao_ferramenta"
        );
      }
      break;
    }

    // Budget check antes de cada iteração
    const budgetCheck = budgetManager.check();
    if (budgetCheck.exceeded) {
      stopReason = budgetCheck.reason ?? "failure";
      break;
    }

    iteration += 1;
    budgetManager.startIteration();

    currentStep.status = "running";

    onProgress?.({
      phase: "iteracao",
      detail: `Executando: ${currentStep.description}`,
      iteration,
      maxIterations: budgets.maxIterations,
    });

    // Prepara contexto: mantém TODA evidência real de ferramenta (filesystem/
    // shell/http) mais as últimas etapas narrativas (LLM). Antes um corte
    // fixo de "últimas 3 etapas" descartava evidência real assim que a
    // investigação passava de ~4 etapas (o caso normal de um plano
    // multiagente com 6+ papéis) — um agente posterior (ex.: CRITIC,
    // SUPERVISOR) perdia acesso ao que o TOOLING/ARQUITETO realmente leram do
    // código e preenchia a lacuna inventando ("package.json com 8 bytes").
    const stepContext = selectRelevantContext(accumulatedContext, RECENT_NARRATIVE_WINDOW);

    // Fase 8 — decide se esta etapa usa uma tool (arquivo/shell/http) com base
    // na descrição/capability. O agente "age" de verdade quando a etapa exige
    // uma ação concreta, não apenas texto.
    const useTool = decideToolForStep(currentStep, task, profile);

    // Executa UMA etapa
    let execResult;
    try {
      execResult = await executeOneStep(currentStep, task, profile, {
        runner,
        toolRegistry: registry,
        providers,
        catalog,
        // F8: weights derivados do histórico evoluído (influenciam o modelo escolhido)
        weights: evolvedWeights ?? weights,
        accumulatedContext: stepContext,
        useTool,
        onProgress,
      });
    } catch (err) {
      if (err instanceof ProviderHttpError) {
        throw err; // Re-propaga para 502
      }
      // Erro genérico → observação de falha
      execResult = {
        observation: {
          success: false,
          output: null,
          error: err instanceof Error ? err.message : String(err),
          exitCode: 1,
          durationMs: 0,
          toolName: "llm:unknown",
          metadata: {},
        },
        estimatedTokens: { input: 0, output: 0, total: 0 },
        estimatedCostUsd: null,
        provider: decision.provider,
        model: decision.model,
      };
    }

    const { observation, estimatedTokens, estimatedCostUsd } = execResult;

    // Registra artefatos (arquivo extraído/gerado) ANTES da validação — o
    // que importa aqui é só se a TOOL teve sucesso de verdade, não se o
    // validador aceitou a etapa como um todo. Nunca lança (ver comentário em
    // artifacts.ts); `sessionId` ausente é um no-op silencioso.
    if (sessionId) {
      registerArtifactsFromObservation(sessionId, observation.toolName, observation);
    }

    // Continuação de uma geração cortada por limite de tokens: prepend o
    // conteúdo já gerado em tentativas anteriores desta MESMA etapa ANTES
    // de validar — assim a validação (inclusive a checagem de truncamento)
    // avalia o resultado COMBINADO, não só o pedaço novo desta tentativa.
    if (currentStep.partialOutput && observation.output) {
      observation.output = currentStep.partialOutput + observation.output;
    }

    // Atualiza budgets
    budgetManager.recordToolCall(estimatedCostUsd ?? 0, estimatedTokens.total);
    accumulatedCostUsd += estimatedCostUsd ?? 0;
    accumulatedTokens += estimatedTokens.total;

    // Validador
    const validation: ValidationResult = await validateStep(
      task,
      currentStep.description,
      observation,
      currentStep.capability,
      {
        enableCritic: autonomousConfig.enableCritic,
        criticModel: autonomousConfig.criticModel,
        profile,
        runner,
        providers,
        catalog,
        rankedCandidates: decision.rankedCandidates ?? [],
        onProgress,
      }
    );

    // Uma vez combinado (ou confirmado completo), o `partialOutput` não deve
    // sobreviver além desta iteração — ou a etapa passou (nada mais a
    // continuar) ou uma nova tentativa vai decidir se acumula mais abaixo.
    currentStep.partialOutput = undefined;

    // Atualiza custo do critic
    if (validation.costUsd) {
      accumulatedCostUsd += validation.costUsd;
    }

    onProgress?.({
      phase: "validacao",
      detail: validation.passed
        ? `Validado: ${currentStep.description}`
        : `Não passou na validação: ${currentStep.description}`,
      passed: validation.passed,
      iteration,
      maxIterations: budgets.maxIterations,
    });

    // Persiste a evidência produzida pela etapa antes de decidir o próximo
    // passo. Assim, uma análise posterior recebe o resultado real de uma tool
    // mesmo quando a decisão atual não percorre o ramo `continue`.
    if (validation.passed && observation.output) {
      accumulatedContext.push(
        `[Evidência da etapa ${currentStep.index + 1} - ${currentStep.capability} - ${observation.toolName}]:\n${observation.output}`
      );
    }

    // Log de diagnóstico quando a validação reprova: sem isso, uma etapa
    // que fica presa em loop de correção (o mesmo padrão já visto 3x nesta
    // investigação — heurísticas de texto rejeitando respostas válidas)
    // só pode ser diagnosticado às cegas, sem o conteúdo real gerado pelo
    // modelo. Trunca o output para não inchar o log nem vazar dados
    // sensíveis inteiros; `issues` já é curto por natureza.
    if (!validation.passed) {
      try {
        getDefaultLogger().warn(
          {
            capability: currentStep.capability,
            stepDescription: currentStep.description,
            issues: validation.issues,
            outputPreview: (observation.output ?? "").slice(0, 300),
            iteration,
          },
          "Etapa não passou na validação"
        );
      } catch {
        // Nunca deixa o logging quebrar o loop.
      }
    }

    // Decision Engine
    const decision_ = decideNextAction({
      step: currentStep,
      observation,
      validation,
      plan: currentPlan,
      profile,
      consecutiveFailures,
      noProgressThreshold: autonomousConfig.noProgressThreshold,
      enableCorrection: autonomousConfig.enableCorrection,
      enableReplanning: autonomousConfig.enableReplanning,
      retrievedMemory,
    });

    // Detecta noProgress
    const toolInputHash = hashToolInput({
      step: currentStep.id,
      observation: observation.output,
    });
    const noProgress = detectNoProgress(
      progressState,
      currentStep,
      observation,
      toolInputHash,
      autonomousConfig.noProgressThreshold
    );

    if (noProgress.detected && decision_.action !== "finish") {
      // Fase 9 — RecoveryCell opt-in: consulta a célula para decidir se replan
      // ou escalar. Fail-open: se a célula falhar ou não sugerir replan, mantém
      // o comportamento F6 (finish por no-progress).
      const cognitive = options.cognitive;
      const useRecovery = cognitive?.enabled === true && consecutiveFailures > 0;

      if (useRecovery) {
        try {
          const maxAttempts = cognitive?.maxRecoveryAttempts ?? 3;
          const recoveryResult = await recoverWithCell(
            noProgress.reason ?? "no_progress",
            consecutiveFailures,
            maxAttempts,
            { sessionId, taskId: episodeId ? `autonomous-${episodeId}` : task },
            cognitive?.recoveryCell
          );

          if (recoveryResult.suggestedAction === "replan" && autonomousConfig.enableReplanning) {
            decision_.action = "replan";
            decision_.reason = `recovery_cell: ${noProgress.reason}`;
          } else if (recoveryResult.suggestedAction === "retry" && autonomousConfig.enableCorrection) {
            decision_.action = "correct";
            decision_.reason = `recovery_cell_retry: ${noProgress.reason}`;
          } else {
            decision_.action = "finish";
            decision_.reason = `no_progress: ${noProgress.reason}`;
            decision_.metadata.terminationReason = "no_progress";
          }
        } catch {
          // Fail-open: célula indisponível → comportamento F6
          decision_.action = "finish";
          decision_.reason = `no_progress: ${noProgress.reason}`;
          decision_.metadata.terminationReason = "no_progress";
        }
      } else {
        decision_.action = "finish";
        decision_.reason = `no_progress: ${noProgress.reason}`;
        decision_.metadata.terminationReason = "no_progress";
      }
    }

    // Registra ciclo (observabilidade)
    recordCycle(
      progressState,
      iteration,
      currentStep,
      observation,
      validation,
      decision_,
      observation.durationMs
    );
    cycleLogs.push(progressState.cycleLogs[progressState.cycleLogs.length - 1]!);

    // Fase 7 — Self Evolution hooks (fail-open)
    try {
      // Curiosity + Goal generation
      curiositySignal = detectCuriosity(curiosityState, progressState, cycleLogs, profile, autonomousConfig.noProgressThreshold);
      if (curiositySignal.shouldExplore) {
        const newGoals = generateGoals(curiositySignal, profile);
        goals.push(...newGoals);
      }
    } catch {
      // Falha aberta
    }

    try {
      // Skill tracking
      updateSkill(skillsState, currentStep.capability, validation.passed, currentStep.description);
    } catch {
      // Falha aberta
    }

    try {
      // Metabolism efficiency tracking
      metabolismState.efficiencyHistory.push({
        success: validation.passed ? 1 : 0,
        cost: estimatedCostUsd ?? 0,
      });
    } catch {
      // Falha aberta
    }

    // Processa a decisão
    if (decision_.action === "finish") {
      // Termina
      const termReason = (decision_.metadata.terminationReason as TerminationReason) ?? "success";
      stopReason = termReason;
      currentStep.status = validation.passed ? "completed" : "failed";

      if (validation.passed) {
        finalResult = buildEvidenceCompleteFinalResult(
          observation.output,
          accumulatedContext,
          currentStep.capability === "execucao_ferramenta"
        );
      }
      break;
    } else if (decision_.action === "correct") {
      // Se a falha foi por truncamento (limite de tokens do provedor), guarda
      // o que já foi gerado — a próxima tentativa vai CONTINUAR a partir
      // daqui (ver `continuationBlock` em executor.ts), em vez de reiniciar
      // do zero e arriscar cortar de novo no mesmo ponto.
      if (
        currentStep.capability === "geracao_codigo" &&
        observation.metadata?.["finishReason"] === "length" &&
        observation.output
      ) {
        currentStep.partialOutput = observation.output;
      }

      // Aplica correção
      const correction = applyCorrection(
        currentPlan,
        currentStep.id,
        validation.suggestedCorrection,
        decision_.reason
      );
      corrections.push(correction);
      consecutiveFailures += 1;
      // NÃO marcar como "failed" — applyCorrection já colocou em "pending"
      // Assim o selectNextStep vai re-selecioná-la na próxima iteração
    } else if (decision_.action === "replan") {
      // Replaneja
      const replanResult = await replan(
        task,
        profile,
        currentPlan,
        currentStep.id,
        runner,
        providers,
        decision.provider,
        decision.model,
        retrievedMemory,
        autonomousConfig.maxPlanSteps
      );
      currentPlan = replanResult.newPlan;
      replans.push(replanResult.replanRecord);
      consecutiveFailures = 0;
      currentStep.status = "failed";
    } else {
      // continue
      currentStep.status = validation.passed ? "completed" : "failed";
      if (validation.passed) {
        finalResult = observation.output;
        consecutiveFailures = 0;
      } else {
        consecutiveFailures += 1;
      }
    }

    // Converte para log de compatibilidade
    const stepLog: AutonomousStepLog = {
      iteration,
      planStepIndex: currentStep.index,
      capability: currentStep.capability,
      actionDescription: currentStep.description,
      provider: execResult.provider,
      model: execResult.model,
      outputContent: observation.output,
      error: observation.error,
      validation: {
        passed: validation.passed,
        heuristic: {
          passed: validation.validatorType === "heuristic" ? validation.passed : true,
          issues: validation.issues,
        },
        critic: validation.validatorType === "critic_llm"
          ? {
              passed: validation.passed,
              confidence: validation.confidence,
              issues: validation.issues,
              suggestedCorrection: validation.suggestedCorrection,
            }
          : null,
      },
      nextDecision: decision_.action,
      usage: (observation.metadata.usage as ChatCompletionResponse["usage"]) ?? undefined,
      estimation: {
        model: execResult.model,
        inputTokens: estimatedTokens.input,
        outputTokens: estimatedTokens.output,
        totalTokens: estimatedTokens.total,
        costUsd: estimatedCostUsd,
      },
      durationMs: observation.durationMs,
    };
    stepLogs.push(stepLog);

    // Persiste no SQLite
    if (episodeId) {
      try {
        const { stepsRepo, validationsRepo } = await import("../lib/db/index.js");
        const stepRow = stepsRepo.create({
          episode_id: episodeId,
          iteration,
          step_type: validation.passed ? "execute" : "correct",
          action_json: JSON.stringify({ action: currentStep.description }),
          observation_json: JSON.stringify(observation),
          validation_json: JSON.stringify(validation),
          decision: decision_.action,
          cost_usd: estimatedCostUsd,
          duration_ms: observation.durationMs,
        });

        validationsRepo.create({
          step_id: stepRow.id,
          validator_type: validation.validatorType,
          passed: validation.passed,
          confidence: validation.confidence,
          issues_json: JSON.stringify(validation.issues),
          suggested_correction: validation.suggestedCorrection,
        });
      } catch {
        // Ignora erros de escrita secundários
      }
    }
  }

  // Não reclassificamos um sucesso real como `max_iterations` apenas porque a
  // última iteração atingiu o limite. O `stopReason` já foi definido pelo
  // budget manager (timeout/max_iterations) ou pela decisão do fluxo.

  onProgress?.({
    phase: "parada",
    detail: `Loop encerrado após ${iteration} iteração(ões): ${stopReason}`,
    iteration,
    maxIterations: budgets.maxIterations,
  });

  // Fallback final: se o loop parou por `no_progress`/`failure` sem resultado
  // (ex.: tool não derivável, LLM sem conteúdo), tenta UMA resposta direta em
  // texto via LLM — o usuário recebe uma resposta útil em vez de erro seco.
  //
  // IMPORTANTE: isso preenche `finalResult`, mas NUNCA reescreve `stopReason`
  // para "success". Antes, qualquer resposta não-vazia dessa última tentativa
  // (mesmo um texto genérico, mesmo repetindo o mesmo erro que já causou o
  // no_progress) fazia o relatório final mentir dizendo "success" — o mesmo
  // tipo de "sucesso" fabricado que motivou toda essa investigação. O usuário
  // (ou o caller da API) precisa saber que a tarefa NÃO foi completada de
  // verdade, mesmo que receba um texto de melhor esforço para ler.
  if (stopReason === "no_progress" || stopReason === "failure") {
    // IMPORTANTE: NÃO checar `finalResult === null` aqui. `finalResult`
    // também é usado pelo caminho de SUCESSO para guardar o output bruto da
    // ÚLTIMA ETAPA QUE PASSOU (ver `finalResult = observation.output` logo
    // acima, e `buildEvidenceCompleteFinalResult`) — então se QUALQUER etapa
    // anterior tiver passado antes do loop travar em no_progress (ex.: a
    // etapa de "listar"/"extrair" deu certo, só a de "ler arquivos
    // principais" que falhou), `finalResult` já vinha preenchido com o JSON
    // bruto daquela tool, e essa checagem pulava a síntese da resposta —
    // o usuário via `{"tool":"compression","action":"list",...}` cru em vez
    // de uma explicação em português do que realmente aconteceu. Aqui
    // SEMPRE descartamos esse valor e tentamos sintetizar de novo.
    finalResult = null;

    if (providers.size > 0) {
      try {
        const fallback = await synthesizeFallbackAnswer(
          task,
          decision.provider,
          decision.model,
          decision.rankedCandidates ?? [],
          providers,
          runner,
          onProgress,
          summarizeRecentFailures(cycleLogs)
        );
        if (fallback) {
          finalResult = fallback;
        }
      } catch {
        // Mantém o stopReason original
      }
    }

    if (finalResult === null) {
      finalResult = `Desculpe, a ação não pôde ser concluída automaticamente devido a um problema no processamento ou validação (${stopReason}). Por favor, verifique se os arquivos e parâmetros informados estão corretos.`;
    }
  }

  const totalDurationMs = Date.now() - startTime;

  // Fase 7 — Persistência de estado evolutivo + Self Reflection (fail-open)
  if (episodeId) {
    try {
      const {
        curiositySignalsRepo,
        goalsRepo,
        skillsRepo,
        strategyScoresRepo,
        metabolismRepo,
      } = await import("../lib/db/index.js");

      // Curiosity signal
      curiositySignalsRepo.create({
        session_id: sessionId,
        task_signature: `${profile.capabilities.join(",")}:${profile.category}`,
        should_explore: curiositySignal.shouldExplore,
        reason: curiositySignal.reason,
        priority: curiositySignal.priority,
        suggested_knowledge: curiositySignal.suggestedKnowledge,
      });

      // Goals
      for (const goal of goals) {
        goalsRepo.create({
          session_id: sessionId,
          goal_id: goal.id,
          description: goal.description,
          priority: goal.priority,
          type: goal.type,
        });
      }

      // Skills snapshot
      const { getSkills } = await import("../evolution/skills.js");
      for (const skill of getSkills(skillsState)) {
        skillsRepo.create({
          session_id: sessionId,
          name: skill.name,
          description: skill.description,
          success_rate: skill.successRate,
          usage_count: skill.usageCount,
          confidence: skill.confidence,
          last_updated: Math.floor(Date.now() / 1000),
        });
      }

      // Strategy outcome
      const { recordStrategyOutcome, scoreStrategies } = await import("../evolution/strategy.js");
      recordStrategyOutcome(strategyState, "autonomous", stopReason === "success", accumulatedCostUsd, totalDurationMs);
      for (const score of scoreStrategies(strategyState)) {
        strategyScoresRepo.create({
          session_id: sessionId,
          strategy: score.strategy,
          success_rate: score.successRate,
          avg_cost: score.avgCost,
          avg_time: score.avgTime,
          sample_count: score.sampleCount,
          last_updated: Math.floor(Date.now() / 1000),
        });
      }

      // Metabolism snapshot
      const { computeEnergyState } = await import("../evolution/metabolism.js");
      const energy = computeEnergyState(budgets, budgetManager, metabolismState);
      metabolismRepo.create({
        session_id: sessionId,
        tokens_available: energy.tokensAvailable,
        budget_available: energy.budgetAvailable,
        efficiency_score: energy.efficiencyScore,
        risk_level: energy.riskLevel,
        taken_at: Math.floor(Date.now() / 1000),
      });

      // Self Reflection
      const episodeData: EpisodeData = {
        episodeId,
        task,
        strategy: "autonomous" as const,
        initialPlan: plan,
        finalPlan: currentPlan,
        steps: cycleLogs.map((log) => ({
          step: currentPlan.steps.find((s) => s.id === log.stepId) ?? {
            id: log.stepId ?? "unknown",
            index: log.iteration,
            description: log.stepDescription,
            capability: log.capability,
            dependencies: [],
            status: "failed",
            attempts: 1,
            maxAttempts: 3,
          },
          observation: log.observation,
          validation: log.validation,
          decision: log.decision,
        })),
        corrections,
        replans,
        finalResult,
        terminationReason: stopReason,
        totalIterations: iteration,
        totalCostUsd: accumulatedCostUsd,
        totalDurationMs,
        totalTokens: accumulatedTokens,
      };
      const reflection = reflect(episodeData, cycleLogs);
      saveReflection({
        session_id: sessionId,
        episode_id: episodeId,
        task,
        plan_worked: reflection.plan_worked ? 1 : 0,
        failed_step: reflection.failed_step,
        improvement_suggestion: reflection.improvement_suggestion,
        missing_knowledge: reflection.missing_knowledge,
        lessons: reflection.lessons,
      });
    } catch {
      // Falha aberta
    }
  }

  // Salva episódio
  if (episodeId) {
    try {
      saveEpisode(
        {
          episodeId,
          task,
          strategy: "autonomous",
          initialPlan: plan,
          finalPlan: currentPlan,
          steps: cycleLogs.map((log) => ({
            step: currentPlan.steps.find((s) => s.id === log.stepId) ?? {
              id: log.stepId ?? "unknown",
              index: log.iteration,
              description: log.stepDescription,
              capability: log.capability,
              dependencies: [],
              status: "failed",
              attempts: 1,
              maxAttempts: 3,
            },
            observation: log.observation,
            validation: log.validation,
            decision: log.decision,
          })),
          corrections,
          replans,
          finalResult,
          terminationReason: stopReason,
          totalIterations: iteration,
          totalCostUsd: accumulatedCostUsd,
          totalDurationMs,
          totalTokens: accumulatedTokens,
        },
        sessionId
      );
    } catch {
      // Ignora erro de memória
    }
  }

  return {
    strategy: "autonomous",
    stopReason,
    iterations: iteration,
    plan: currentPlan.steps.map((s) => ({
      id: s.id,
      index: s.index,
      description: s.description,
      objective: s.objective,
      capability: s.capability,
      dependencies: s.dependencies,
      status: s.status,
      attempts: s.attempts,
      result: s.result ?? undefined,
      validation: s.validation ?? undefined,
    })),
    stepLogs,
    finalResult,
    totalTokens: accumulatedTokens,
    totalCostUsd: accumulatedCostUsd,
    totalDurationMs,
    episodeId,
    error: stopReason === "success" ? null : `Encerramento com status: ${stopReason}`,
  };
}

/**
 * Fase 8 — Decide se uma etapa deve executar uma tool real.
 *
 * Regras determinísticas (fail-open):
 * - Etapa menciona "arquivo"/"criar arquivo"/"escrever"/"ler" → filesystem
 * - Etapa menciona "comando"/"shell"/"rodar"/"executar" → shell
 * - Etapa menciona "url"/"http"/"api"/"requisita" → http
 * - Senão → null (etapa via LLM)
 *
 * Retorna o tipo de tool ou null. Nunca lança.
 */
function decideToolForStep(
  step: PlanStep,
  task: string,
  profile: TaskProfile
): "filesystem" | "shell" | "http" | "document" | "compression" | "image" | "project" | null {
  try {
    // Sinal AUTORITATIVO: a capability da etapa. Antes, QUALQUER etapa cujo
    // texto mencionasse a palavra "arquivo" — mesmo uma etapa de
    // *planejamento* que só fala SOBRE criar um arquivo, sem executar nada —
    // era tratada como execução de ferramenta real, o que travava o loop
    // tentando extrair um path/conteúdo de um texto que não descrevia uma
    // ação concreta. Agora só etapas que o Planner rotulou explicitamente
    // como `execucao_ferramenta` (ou o plano fallback determinístico, que
    // usa a mesma capability) podem acionar uma tool.
    if (step.capability !== "execucao_ferramenta") {
      return null;
    }

    // A etapa É de execução de ferramenta — falta só decidir QUAL tool.
    // 1º: o texto da própria etapa (o Planner normalmente já é específico
    // o bastante: "criar o arquivo X com o conteúdo Y").
    const stepText = `${step.description} ${step.objective ?? ""}`.toLowerCase();
    const fromStep = detectToolIntent(stepText);
    if (fromStep) return fromStep;

    // 2º: a etapa foi corretamente rotulada, mas seu texto não deixa claro
    // QUAL tool (ex.: "Executar a ação necessária", do plano fallback
    // determinístico) — usa o sinal já calculado a nível de tarefa inteira
    // (F1, mesma fonte que a strategyEngine usa para decidir o modo
    // autônomo), em vez de reprocessar tudo de novo.
    return profile.toolIntent ?? detectToolIntent(task);
  } catch {
    return null;
  }
}

/**
 * Seleciona a próxima etapa executável do plano.
 */
/** Quantas etapas puramente narrativas (sem tool real) recentes ficam no contexto. */
const RECENT_NARRATIVE_WINDOW = 6;

/**
 * Seleciona quais evidências acumuladas entram no contexto da próxima etapa.
 *
 * Evidência de `execucao_ferramenta` (filesystem/shell/http real) é mantida
 * SEMPRE, na ordem original — é o único dado factual que o sistema tem, e
 * descartá-la é o que causava um agente posterior "inventar" um fato que já
 * havia sido apurado por outro agente algumas etapas antes. Evidência
 * puramente narrativa (LLM: analise/planejamento/critic/supervisor) é
 * limitada às últimas `RECENT_NARRATIVE_WINDOW`, para não inflar o prompt
 * indefinidamente num plano longo — `MAX_CONTEXT_CHARS` em `executor.ts`
 * ainda corta o total se necessário, preservando o final (mais recente).
 */
function selectRelevantContext(context: string[], recentNarrativeWindow: number): string[] {
  if (context.length <= recentNarrativeWindow) {
    return context;
  }
  const isToolEvidence = (entry: string) => / - execucao_ferramenta - /.test(entry);
  const cutoff = context.length - recentNarrativeWindow;
  const kept: string[] = [];
  for (let i = 0; i < context.length; i++) {
    const entry = context[i]!;
    if (i >= cutoff || isToolEvidence(entry)) {
      kept.push(entry);
    }
  }
  return kept;
}

/**
 * Conta/extrai as evidências REAIS de ferramenta (não narrativa de LLM) já
 * acumuladas, na ordem em que ocorreram.
 */
function extractToolEvidence(accumulatedContext: string[]): string[] {
  return accumulatedContext.filter((entry) => / - execucao_ferramenta - /.test(entry));
}

/**
 * Quando o plano termina logo após uma etapa de ferramenta (sem nenhuma
 * etapa narrativa depois para "resumir" o que aconteceu — o caso normal
 * depois da correção de `stopsImmediatelyAfterTools`), `finalResult` só
 * carregava o output da ÚLTIMA etapa executada, descartando silenciosamente
 * qualquer evidência de etapas de ferramenta anteriores (ex.: um plano
 * `filesystem.list` → `filesystem.read` só devolvia o conteúdo do `read`,
 * "esquecendo" o resultado do `list`).
 *
 * Quando há 2+ evidências reais de ferramenta E a última etapa executada
 * foi ela mesma uma ferramenta (não uma etapa narrativa que já deveria ter
 * sintetizado tudo em texto), a resposta final passa a ser a concatenação
 * de TODAS as evidências — nunca só a mais recente. "A ferramenta é a
 * fonte de verdade": a resposta final nunca deve dizer que uma evidência
 * "não está disponível" quando ela está, só que numa etapa anterior.
 */
function buildEvidenceCompleteFinalResult(
  currentFinalResult: string | null,
  accumulatedContext: string[],
  lastCompletedStepWasTool: boolean
): string | null {
  if (!lastCompletedStepWasTool) return currentFinalResult;
  const toolEvidence = extractToolEvidence(accumulatedContext);
  if (toolEvidence.length < 2) return currentFinalResult;
  return toolEvidence.join("\n\n");
}

function selectNextStep(plan: Plan): PlanStep | null {
  // Marca etapas concluídas (caso haja inconsistência)
  for (const step of plan.steps) {
    if (step.status === "running") {
      step.status = "pending"; // Reset se travou
    }
  }

  // Procura primeira pending com dependências atendidas
  for (const step of plan.steps) {
    if (step.status === "pending") {
      const depsMet = step.dependencies.every((depId) => {
        const dep = plan.steps.find((s) => s.id === depId);
        return dep?.status === "completed";
      });

      if (depsMet) {
        return step;
      }
    }
  }

  return null;
}

/**
 * Resume os erros de tool mais recentes/relevantes de `cycleLogs` para dar
 * contexto real ao fallback final — sem isso, `synthesizeFallbackAnswer`
 * só via o texto original da tarefa e tinha que ADIVINHAR por que o loop
 * falhou, mesmo quando a tool já havia devolvido um motivo claro (ex.:
 * "criação de .rar requer CLI licenciada, use .zip"). Pega só as últimas
 * mensagens de erro DISTINTAS (mais recente primeiro) para não estourar o
 * prompt em loops longos com o mesmo erro repetido dezenas de vezes.
 */
export function summarizeRecentFailures(logs: CycleLog[], maxDistinct = 3): string | null {
  const seen = new Set<string>();
  const distinct: string[] = [];

  for (let i = logs.length - 1; i >= 0 && distinct.length < maxDistinct; i--) {
    const obs = logs[i]?.observation;
    const errorText = obs?.error || (obs?.success === false ? obs?.output : null);
    if (!errorText) continue;
    const trimmed = String(errorText).slice(0, 400);
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    distinct.push(`- ferramenta "${logs[i]?.toolName ?? "desconhecida"}": ${trimmed}`);
  }

  return distinct.length > 0 ? distinct.join("\n") : null;
}

/**
 * Última tentativa após `no_progress`/`failure`: pede ao LLM UMA resposta
 * direta em texto sobre a tarefa (sem tool, sem plano). Retorna o conteúdo ou
 * null se indisponível. Nunca lança.
 */
async function synthesizeFallbackAnswer(
  task: string,
  decisionProvider: string | null,
  decisionModel: string | null,
  rankedCandidates: readonly FallbackCandidate[],
  providers: Map<string, ProviderAdapter>,
  runner: LLMRunner | undefined,
  onProgress?: ProgressEmitter,
  failureContext?: string | null
): Promise<string | null> {
  if (!decisionProvider || !decisionModel) return null;
  try {
    const candidates = buildCandidateList(decisionProvider, decisionModel, rankedCandidates, providers);
    const contextBlock = failureContext
      ? `\n\nContexto: as tentativas automáticas de executar essa tarefa com ferramentas falharam com os seguintes motivos (use-os para explicar ao usuário o que realmente aconteceu e sugerir uma alternativa concreta, em vez de um pedido de desculpas genérico):\n${failureContext}`
      : "";
    const { response } = await completeWithFallback(
      (candidate) => ({
        provider: candidate.provider as ChatCompletionRequest["provider"],
        model: candidate.model,
        messages: [
          {
            role: "system",
            content:
              "Responda à tarefa do usuário de forma direta e útil, em texto simples. Se não souber a resposta, diga isso claramente e sugira próximos passos — nunca invente fatos, nunca retorne erro seco. Se houver contexto sobre por que uma execução automática falhou, explique o motivo real ao usuário (de forma simples, sem jargão interno) e ofereça uma alternativa viável." +
              contextBlock,
          },
          { role: "user", content: task },
        ],
        temperature: 0.7,
        max_tokens: 1024,
        stream: false,
      }),
      providers,
      candidates,
      { runner, onProgress }
    );
    const content = response.content?.trim();
    return content ? content : null;
  } catch {
    return null;
  }
}

// Reexport tipos para compatibilidade
export type {
  Plan,
  PlanStep,
  Observation,
  ValidationResult,
  Decision,
  AutonomousConfig,
  CycleLog,
  TerminationReason,
} from "./types.js";

export { BudgetManager } from "./budget.js";
export { retrieveRelevantMemory } from "./memoryRetrieval.js";
export { planTask } from "./planner.js";
export { executeOneStep } from "./executor.js";
export { validateStep } from "./validator.js";
export { decideNextAction, applyCorrection, replan } from "./decision.js";
export {
  createProgressState,
  detectNoProgress,
  recordCycle,
  generateObservabilitySummary,
} from "./progressTracker.js";
export { saveEpisode, generateLessonsLearned } from "./episodicMemory.js";
export {
  createDefaultToolRegistry,
  DefaultToolRegistry,
  type ToolRegistry,
  type ToolRegistryOptions,
} from "./tools/registry.js";
