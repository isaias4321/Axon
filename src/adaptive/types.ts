/**
 * Fase 6 — Tipos compartilhados do Autonomous Behavior Engine.
 *
 * Este módulo define os tipos que compõem o estado explícito de execução
 * autônoma, bem como o contrato entre Planner, Executor, Observer,
 * Validator, Critic e Decision Engine.
 */

import type { CostEstimate } from "./costEstimator.js";
import type { TaskCapability, TaskProfile } from "./taskAnalyzer.js";
import type { StrategyDecision } from "./strategyEngine.js";

/** Orçamentos de autonomia (definidos no autonomous.ts, reutilizados aqui). */
export interface AutonomousBudgets {
  maxIterations: number;
  maxCostUsd: number;
  maxDurationMs: number;
  maxToolCalls?: number;
  maxTokens?: number;
}

/** Estratégias de execução do sistema. */
export type Strategy = "single_agent" | "multi_agent" | "autonomous" | "no_execution";

/**
 * Estado explícito de execução autônoma.
 * Tudo o que o loop precisa saber sobre onde está e para onde vai.
 */
export interface AutonomousState {
  task: string;
  taskId: string;
  episodeId: number | null;
  episodeIdStr: string;
  currentPlan: Plan;
  completedSteps: Set<string>;
  failedSteps: Set<string>;
  observations: Observation[];
  validations: ValidationResult[];
  corrections: CorrectionRecord[];
  replans: ReplanRecord[];
  iterationCount: number;
  toolCallCount: number;
  tokenUsage: TokenUsage;
  estimatedCostUsd: number;
  startedAt: number;
  lastProgressAt: number;
  status: "running" | "completed" | "failed" | "stopped";
  terminationReason: TerminationReason | null;
}

/** Uso de tokens acumulado durante todo o episódio. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/** Alias para uso em resultados de validação (compatibilidade). */
export interface TokenUsageShort {
  input: number;
  output: number;
  total: number;
}

/** Motivos de término do loop autônomo. */
export type TerminationReason =
  | "success"
  | "failure"
  | "max_iterations"
  | "max_cost"
  | "timeout"
  | "max_tool_calls"
  | "max_tokens"
  | "no_progress";

/**
 * Plano estruturado — uma árvore plana de etapas com dependências.
 * O plano inicial é uma hipótese; pode ser modificado (replanned) a qualquer momento.
 */
export interface Plan {
  id: string;
  steps: PlanStep[];
  /** Índice do próximo step a ser executado (considerando dependências). */
  nextStepId: string | null;
}

/**
 * Uma única etapa do plano. Cada etapa é uma unidade de trabalho.
 */
export interface PlanStep {
  id: string;
  index: number;
  description: string;
  objective?: string;
  capability: TaskCapability;
  dependencies: string[];
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  attempts: number;
  maxAttempts: number;
  /** Resultado da última execuição desta etapa. */
  result?: string | null;
  /** Validação da última execução. */
  validation?: string | null;
  /** Quando foi concluída ou falhou pela última vez. */
  completedAt?: number | null;
  /** Contexto acumulado relevante a esta etapa. */
  context?: string;
  /**
   * Conteúdo já gerado por uma tentativa anterior desta etapa que foi
   * cortada pelo limite de tokens do provedor (finish_reason="length").
   * Usado para pedir uma CONTINUAÇÃO exata em vez de reiniciar do zero —
   * sem isso, cada nova tentativa podia cortar de novo no mesmo lugar,
   * desperdiçando o orçamento de tokens em regenerar o mesmo início.
   */
  partialOutput?: string;
}

/** Observação estruturada do resultado de uma tool call. */
export interface Observation {
  success: boolean;
  output: string | null;
  error: string | null;
  /** Código de saída (para tools shell). */
  exitCode: number | null;
  durationMs: number;
  filesChanged?: string[];
  toolName: string;
  metadata: Record<string, unknown>;
}

/** Resultado estruturado da validação. */
export interface ValidationResult {
  passed: boolean;
  validatorType: "heuristic" | "critic_llm";
  confidence: number;
  issues: string[];
  suggestedCorrection: string | null;
  costUsd?: number | null;
  tokens?: TokenUsage;
}

/** Registro de uma correção aplicada. */
export interface CorrectionRecord {
  stepId: string;
  originalStep: PlanStep;
  correctedStep: PlanStep;
  reason: string;
  timestamp: number;
}

/** Registro de um replanejamento. */
export interface ReplanRecord {
  reason: string;
  oldPlan: Plan;
  newPlan: Plan;
  timestamp: number;
  replacedStepIds: string[];
}

/** Decisão do Decision Engine após observação + validação. */
export interface Decision {
  action: "continue" | "correct" | "replan" | "finish";
  reason: string;
  confidence: number;
  /** Campos auxiliares para logging observável. */
  metadata: Record<string, unknown>;
}

/** Configuração completa da Fase 6. */
export interface AutonomousConfig {
  budgets: AutonomousBudgets;
  enableMemoryRetrieval: boolean;
  enableCritic: boolean;
  enableReplanning: boolean;
  enableCorrection: boolean;
  noProgressThreshold: number;
  criticModel?: string;
  maxPlanSteps: number;
}

/** Estado de um passo do loop para observabilidade. */
export interface CycleLog {
  iteration: number;
  stepId: string | null;
  stepDescription: string;
  capability: TaskCapability;
  toolName: string;
  observation: Observation;
  validation: ValidationResult;
  decision: Decision;
  timestamp: number;
  durationMs: number;
}

/** Interface de tool genérica. */
export interface Tool<TInput = unknown> {
  name: string;
  description: string;
  execute(input: TInput): Promise<ToolResult>;
}

/** Resultado estruturado de uma tool. */
export interface ToolResult {
  success: boolean;
  output: string | null;
  error: string | null;
  exitCode: number | null;
  durationMs: number;
  filesChanged?: string[];
  metadata: Record<string, unknown>;
}

/** Reutiliza os tipos existentes das Fases 1–5. */
export type { TaskProfile, TaskCapability, StrategyDecision, CostEstimate };
