/**
 * Fase 7 — Curiosity Engine.
 *
 * Detecta sinais de curiosidade a partir do histórico de execução:
 * - Tarefas repetidas
 * - Baixa confiança nas validações
 * - Erros recorrentes
 * - Alta taxa de falha
 * - Baixa taxa de sucesso geral
 */

import type { ProgressState, CycleLog } from "../adaptive/progressTracker.js";
import type { TaskProfile } from "../adaptive/taskAnalyzer.js";
import type { CuriosityState, CuriositySignal } from "./types.js";

export type { CuriositySignal };

/** Cria estado inicial vazio. */
export function createCuriosityState(): CuriosityState {
  return {
    signalHistory: new Map<string, number>(),
    recentTasks: [],
  };
}

/**
 * Analisa progresso + observações/validações e decide se há sinal de curiosidade.
 *
 * Triggers:
 * - repeatedTaskSignature: mesma capability + categoria vista >= threshold vezes
 * - lowConfidence: confiança < 0.5 em >= 2 passos consecutivos
 * - frequentErrors: mesmo erro repetido >= threshold vezes
 * - validationFailure: >= 50% dos últimos N passos falharam validação
 * - lowSuccessRate: taxa de sucesso geral < 50%
 *
 * Retorna o sinal de maior prioridade ou no-op.
 */
export function detectCuriosity(
  state: CuriosityState,
  progressState: ProgressState,
  cycleLogs: CycleLog[],
  profile: TaskProfile,
  threshold: number
): CuriositySignal {
  // Assinatura da tarefa atual
  const taskSignature = `${profile.capabilities.join(",")}::${profile.category}`;

  // 1) Tarefa repetida
  const recentCount = state.recentTasks.filter((sig) => sig === taskSignature).length;
  if (recentCount >= threshold) {
    state.recentTasks.push(taskSignature);
    return {
      shouldExplore: true,
      reason: `Tarefa repetida ${recentCount + 1}x (assinatura: ${taskSignature})`,
      priority: Math.min(0.9, 0.3 + recentCount * 0.1),
      suggestedKnowledge: profile.capabilities[0] ?? "geral",
    };
  }

  // 2) Baixa confiança em passos consecutivos
  let lowConfidenceStreak = 0;
  for (let i = cycleLogs.length - 1; i >= 0; i--) {
    const log = cycleLogs[i]!;
    if (!log.validation.passed || log.validation.confidence < 0.5) {
      lowConfidenceStreak++;
      if (lowConfidenceStreak >= 2) {
        return {
          shouldExplore: true,
          reason: `Baixa confiança em ${lowConfidenceStreak} passos consecutivos`,
          priority: 0.7,
          suggestedKnowledge: log.capability,
        };
      }
    } else {
      break;
    }
  }

  // 3) Erros frequentes
  for (const [errorKey, count] of progressState.errorCounts.entries()) {
    if (count >= threshold) {
      return {
        shouldExplore: true,
        reason: `Erro recorrente (${count}x): ${errorKey.substring(0, 60)}...`,
        priority: 0.8,
        suggestedKnowledge: "validacao",
      };
    }
  }

  // 4) Alta taxa de falha de validação
  const recentLogs = cycleLogs.slice(-threshold * 2);
  if (recentLogs.length >= threshold) {
    const failedCount = recentLogs.filter((log) => !log.validation.passed).length;
    const failureRate = failedCount / recentLogs.length;
    if (failureRate >= 0.5) {
      return {
        shouldExplore: true,
        reason: `Alta taxa de falha (${Math.round(failureRate * 100)}%) nos últimos ${recentLogs.length} passos`,
        priority: 0.75,
        suggestedKnowledge: "validacao",
      };
    }
  }

  // 5) Baixa taxa de sucesso geral
  const totalSteps = cycleLogs.length;
  if (totalSteps > 0) {
    const successCount = cycleLogs.filter((log) => log.validation.passed).length;
    const successRate = successCount / totalSteps;
    if (successRate < 0.5) {
      return {
        shouldExplore: true,
        reason: `Baixa taxa de sucesso geral (${Math.round(successRate * 100)}%)`,
        priority: 0.6,
        suggestedKnowledge: "planejamento",
      };
    }
  }

  // Sem sinal — atualiza histórico
  state.recentTasks.push(taskSignature);
  if (state.recentTasks.length > threshold * 5) {
    state.recentTasks.shift();
  }

  return { shouldExplore: false, reason: "", priority: 0, suggestedKnowledge: "" };
}