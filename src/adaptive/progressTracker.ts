/**
 * Fase 6 — Progress Tracker & Observability.
 *
 * Detecta falta de progresso (noProgress) e registra ciclos para observabilidade.
 * NÃO expõe chain-of-thought privado do LLM — apenas metadados e justificativas
 * operacionais seguras.
 */

import type { PlanStep, Observation, ValidationResult, Decision, CycleLog } from "./types.js";

export type { CycleLog };

export interface ProgressState {
  /** Erros repetidos (hash do erro → contagem). */
  errorCounts: Map<string, number>;
  /** Tool calls repetidas (hash do input → contagem). */
  toolCallCounts: Map<string, number>;
  /** Etapas repetidas sem mudança (stepId → contagem de tentativas). */
  stepAttempts: Map<string, number>;
  /** Última observação de progresso observável. */
  lastObservableProgress: number;
  /** Contador de iterações sem progresso. */
  iterationsWithoutProgress: number;
  /** Histórico de ciclos para auditoria. */
  cycleLogs: CycleLog[];
}

export function createProgressState(): ProgressState {
  return {
    errorCounts: new Map(),
    toolCallCounts: new Map(),
    stepAttempts: new Map(),
    lastObservableProgress: Date.now(),
    iterationsWithoutProgress: 0,
    cycleLogs: [],
  };
}

/**
 * Detecta falta de progresso.
 *
 * Condições:
 * 1. Mesmo erro repetido >= threshold vezes
 * 2. Mesma tool call repetida >= threshold vezes
 * 3. Mesma etapa repetida sem mudança >= threshold vezes
 * 4. Nenhum aumento de progresso por N iterações
 */
export function detectNoProgress(
  state: ProgressState,
  step: PlanStep,
  observation: Observation,
  toolInputHash: string,
  threshold: number
): { detected: boolean; reason: string | null } {
  // 1. Mesmo erro repetido
  if (observation.error) {
    const errorKey = observation.error.substring(0, 100);
    const count = (state.errorCounts.get(errorKey) ?? 0) + 1;
    state.errorCounts.set(errorKey, count);

    if (count >= threshold) {
      return { detected: true, reason: `Mismo erro repetido ${count}x: ${errorKey}` };
    }
  }

  // 2. Mesma tool call repetida
  if (toolInputHash) {
    const count = (state.toolCallCounts.get(toolInputHash) ?? 0) + 1;
    state.toolCallCounts.set(toolInputHash, count);

    if (count >= threshold) {
      return { detected: true, reason: `Mesma tool call repetida ${count}x` };
    }
  }

  // 3. Mesma etapa repetida
  const stepKey = step.id;
  const stepCount = (state.stepAttempts.get(stepKey) ?? 0) + 1;
  state.stepAttempts.set(stepKey, stepCount);

  if (stepCount >= threshold && observation.success === false) {
    return { detected: true, reason: `Etapa '${step.id}' repetida ${stepCount}x sem sucesso` };
  }

  // 4. Nenhum progresso observável por muitas iterações
  if (observation.success && observation.output) {
    state.lastObservableProgress = Date.now();
    state.iterationsWithoutProgress = 0;
  } else {
    state.iterationsWithoutProgress += 1;
    if (state.iterationsWithoutProgress >= threshold * 2) {
      return { detected: true, reason: `Nenhum progresso observável por ${state.iterationsWithoutProgress} iterações` };
    }
  }

  return { detected: false, reason: null };
}

/**
 * Registra um ciclo para observabilidade.
 *
 * NÃO registra chain-of-thought privado do LLM — apenas metadados seguros.
 */
export function recordCycle(
  state: ProgressState,
  iteration: number,
  step: PlanStep | null,
  observation: Observation,
  validation: ValidationResult,
  decision: Decision,
  durationMs: number
): void {
  const log: CycleLog = {
    iteration,
    stepId: step?.id ?? null,
    stepDescription: step?.description ?? "(nenhuma etapa)",
    capability: step?.capability ?? "raciocinio",
    toolName: observation.toolName,
    observation: {
      ...observation,
      // Não expõe output completo se for muito longo (privacidade)
      output: observation.output
        ? observation.output.length > 500
          ? observation.output.substring(0, 500) + "...[truncado]"
          : observation.output
        : null,
    },
    validation: {
      ...validation,
      issues: validation.issues.slice(0, 10), // Limita issues registrados
    },
    decision,
    timestamp: Date.now(),
    durationMs,
  };

  state.cycleLogs.push(log);
}

/**
 * Gera resumo de observabilidade para logs/auditoria.
 */
export function generateObservabilitySummary(state: ProgressState): {
  totalCycles: number;
  decisions: Record<string, number>;
  toolsUsed: Record<string, number>;
  avgDurationMs: number;
  errorsDetected: number;
} {
  const decisions: Record<string, number> = {};
  const toolsUsed: Record<string, number> = {};
  let totalDuration = 0;

  for (const log of state.cycleLogs) {
    decisions[log.decision.action] = (decisions[log.decision.action] ?? 0) + 1;
    toolsUsed[log.toolName] = (toolsUsed[log.toolName] ?? 0) + 1;
    totalDuration += log.durationMs;
  }

  return {
    totalCycles: state.cycleLogs.length,
    decisions,
    toolsUsed,
    avgDurationMs: state.cycleLogs.length > 0 ? totalDuration / state.cycleLogs.length : 0,
    errorsDetected: state.errorCounts.size,
  };
}

/**
 * Cria hash do input da tool para detecção de repetição.
 */
export function hashToolInput(input: unknown): string {
  try {
    const str = typeof input === "string" ? input : JSON.stringify(input);
    // Hash simples (não criptográfico, só para deduplicação)
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash;
    }
    return hash.toString(36);
  } catch {
    return "unknown";
  }
}
