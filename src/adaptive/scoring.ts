/**
 * Fase 2 — Scoring adaptativo por tarefa.
 *
 * A Fase 1 usava pesos FIXOS (`DEFAULT_WEIGHTS`) para todos os tipos de
 * tarefa. Aqui os pesos passam a depender da tarefa: o "mínimo de
 * inteligência necessária" muda conforme a categoria e a complexidade.
 *
 * A intenção:
 * - Conversa simples → o barato/rápido importa mais (custo e latência
 *   ganham peso; a capacidade já é suficiente em qualquer modelo).
 * - Código / análise / planejamento → acertar é o mais importante
 *   (capacidade e adequação ganham peso; economizar custo é secundário).
 * - Tarefa de alta complexidade → sobe o peso da capacidade (não
 *   economizar capacidade no momento em que mais se precisa dela).
 * - Tarefa simples → sobe o peso do custo (qualquer modelo razoável
 *   resolve; prefere-se o mais barato).
 *
 * Determinístico e sem IO, como o resto da camada `adaptive/`.
 */

import type { TaskCategory, TaskComplexity, TaskProfile } from "./taskAnalyzer.js";

/**
 * Pesos do scoring ponderado por candidato. Somam 1.0.
 * Os pesos vivem AQUI (não em modelRouter.ts) para evitar import circular:
 * `modelRouter` importa `scoringWeightsFor`, então a fonte dos pesos precisa
 * estar neste módulo.
 */
export interface ScoringWeights {
  capability: number;
  suitability: number;
  cost: number;
  latency: number;
}

/** Pesos da filosofia: capacidade primeiro, depois adequação, custo e latência. */
export const DEFAULT_WEIGHTS: ScoringWeights = {
  capability: 0.4,
  suitability: 0.25,
  cost: 0.2,
  latency: 0.15,
};

/** Pesos base por categoria — somam 1.0 (fallback `geral` = DEFAULT_WEIGHTS). */
const CATEGORY_WEIGHTS: Record<TaskCategory, ScoringWeights> = {
  conversacao: { capability: 0.2, suitability: 0.15, cost: 0.35, latency: 0.3 },
  codigo: { capability: 0.5, suitability: 0.25, cost: 0.15, latency: 0.1 },
  analise: { capability: 0.45, suitability: 0.25, cost: 0.15, latency: 0.15 },
  planejamento: { capability: 0.45, suitability: 0.3, cost: 0.15, latency: 0.1 },
  geral: DEFAULT_WEIGHTS,
};

/** Ajuste fino por complexidade — aplicado por cima dos pesos da categoria. */
const COMPLEXITY_DELTA: Record<
  TaskComplexity,
  { capability: number; cost: number }
> = {
  // Tarefa difícil: valorizar capacidade, economizar custo importa menos.
  alta: { capability: +0.05, cost: -0.05 },
  // Tarefa simples: qualquer modelo resolve — preferir o mais barato.
  baixa: { capability: -0.05, cost: +0.05 },
  media: { capability: 0, cost: 0 },
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Calcula os pesos de scoring para uma tarefa.
 * Categoria define a base; complexidade aplica um ajuste fino. O resultado
 * sempre soma 1.0 e nenhum peso fica fora de [0, 1].
 */
export function scoringWeightsFor(profile: TaskProfile): ScoringWeights {
  const base = CATEGORY_WEIGHTS[profile.category];
  const delta = COMPLEXITY_DELTA[profile.complexity];

  const weights: ScoringWeights = {
    capability: clamp(base.capability + delta.capability, 0, 1),
    suitability: base.suitability,
    cost: clamp(base.cost + delta.cost, 0, 1),
    latency: base.latency,
  };

  // Re-normaliza se o clamp deslocou a soma de 1.0.
  const sum =
    weights.capability + weights.suitability + weights.cost + weights.latency;

  if (sum === 1) return weights;

  return {
    capability: weights.capability / sum,
    suitability: weights.suitability / sum,
    cost: weights.cost / sum,
    latency: weights.latency / sum,
  };
}
