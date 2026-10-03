/**
 * Fase 7 — Strategy Evolution.
 *
 * Compara e ranqueia estratégias baseadas em sucesso histórico, custo e tempo.
 */

import type { StrategyState, StrategyScore, StrategyCounters } from "./types.js";
import type { Strategy as AdaptiveStrategy } from "../adaptive/types.js";

export type { StrategyState, StrategyScore, StrategyCounters };

/** Cria estado inicial de evolution de estratégias. */
export function createStrategyState(): StrategyState {
  return { byStrategy: new Map<string, StrategyCounters>() };
}

/**
 * Registra o resultado de uma execução de estratégia.
 */
export function recordStrategyOutcome(
  state: StrategyState,
  strategy: AdaptiveStrategy,
  success: boolean,
  costUsd: number,
  durationMs: number
): void {
  const counters = state.byStrategy.get(strategy) ?? {
    strategy,
    successes: 0,
    failures: 0,
    totalCost: 0,
    totalDuration: 0,
    sampleCount: 0,
  };
  counters.successes += success ? 1 : 0;
  counters.failures += success ? 0 : 1;
  counters.totalCost += costUsd;
  counters.totalDuration += durationMs;
  counters.sampleCount += 1;
  state.byStrategy.set(strategy, counters);
}

/** Calcula scores e ranqueia (melhor primeiro). */
export function scoreStrategies(state: StrategyState): StrategyScore[] {
  return Array.from(state.byStrategy.entries())
    .map(([strategy, counters]) => ({
      strategy,
      successRate: counters.successes / counters.sampleCount,
      avgCost: counters.totalCost / counters.sampleCount,
      avgTime: counters.totalDuration / counters.sampleCount,
      sampleCount: counters.sampleCount,
    }))
    .sort((a, b) => (b.successRate - a.successRate) || (a.avgCost - b.avgCost) || (a.avgTime - b.avgTime));
}

/**
 * Retorna a estratégia com maior sucesso (minSamples mínimo).
 * Retorna null se nenhuma atender ao mínimo.
 */
export function bestStrategy(state: StrategyState, minSamples: number): AdaptiveStrategy | null {
  const scored = scoreStrategies(state).filter((s) => s.sampleCount >= minSamples);
  const best = scored[0];
  if (!best) return null;
  return best.strategy as AdaptiveStrategy;
}