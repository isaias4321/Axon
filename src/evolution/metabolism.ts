/**
 * Fase 7 — Metabolism Manager.
 *
 * Gerencia o estado energético do agente e decide qual tier de modelo usar.
 * Reutiliza modelCatalog.MODEL_CATALOG e costEstimator.costPriceFor/estimateCostUsd.
 */

import type { AutonomousBudgets, BudgetManager } from "../adaptive/budget.js";
import type { TaskProfile } from "../adaptive/taskAnalyzer.js";
import type { ModelEntry } from "../adaptive/modelCatalog.js";
import type { CostPrice } from "../adaptive/costEstimator.js";
import type { EnergyState, ModelTier, ModelChoice, MetabolismState, EnergySnapshot } from "./types.js";

export type { EnergyState, ModelTier, ModelChoice, MetabolismState, EnergySnapshot };

/** Cria estado metabólico inicial. */
export function createMetabolismState(): MetabolismState {
  return {
    snapshots: [],
    efficiencyHistory: [],
  };
}

/**
 * Calcula o estado energético atual baseado no orçamento e histórico de eficiência.
 */
export function computeEnergyState(
  budgets: AutonomousBudgets,
  budgetManager: BudgetManager,
  state: MetabolismState
): EnergyState {
  const usage = budgetManager.getUsage();
  const budgetAvailable = Math.max(0, budgets.maxCostUsd - usage.costUsd);
  const tokensAvailable = Math.max(0, (budgets.maxTokens ?? 0) - usage.tokens);
  const budgetRemainingRatio = budgets.maxCostUsd > 0 ? budgetAvailable / budgets.maxCostUsd : 1;

  // Score de eficiência: média móvel ponderada de (sucesso ? 1 : 0.1) / (custo + 0.001)
  let efficiencyScore = 0.5; // default neutro
  if (state.efficiencyHistory.length > 0) {
    const sum = state.efficiencyHistory.reduce((acc, h) => {
      const val = (h.success ? 1 : 0.1) / (h.cost + 0.001);
      return acc + val;
    }, 0);
    efficiencyScore = Math.min(1, Math.max(0, sum / state.efficiencyHistory.length));
  }

  // Nível de risco
  let riskLevel: "low" | "medium" | "high" = "low";
  if (budgetRemainingRatio < 0.2) riskLevel = "high";
  else if (budgetRemainingRatio < 0.5) riskLevel = "medium";

  return {
    tokensAvailable,
    budgetAvailable,
    efficiencyScore,
    riskLevel,
  };
}

/**
 * Decide qual tier de modelo usar baseado na energia e criticidade.
 *
 * Regras:
 * - Baixa energia (budget < 20% restante) → cheap tier
 * - Alta eficiência (> 1.0) → pode usar balanced
 * - Passo crítico (confidence < 0.3) → expensive tier (se orçamento permite)
 * - Default → balanced
 */
export function chooseModelTier(
  energy: EnergyState,
  profile: TaskProfile,
  catalog: readonly ModelEntry[],
  critical: boolean
): ModelChoice {
  // Filtra catálogo para capacidades compatíveis
  const requiredCaps = new Set(profile.capabilities);
  const compatible = catalog.filter((m) =>
    m.capabilities.some((cap) => requiredCaps.has(cap))
  );

  if (compatible.length === 0) {
    // Fallback: usa primeiro modelo do catálogo (se houver)
    const fallback = catalog[0] ?? { model: "unknown", provider: "unknown", capabilities: [] };
    return {
      model: fallback.model,
      provider: fallback.provider,
      tier: "balanced",
      reason: "Nenhum modelo compatível — fallback",
    };
  }

  // Ordena por custo crescente (blend input+output)
  const withPrice = compatible.map((m) => {
    const price = costPriceFor(m.model, catalog);
    return { ...m, price };
  }).filter((m) => m.price !== null);

  if (withPrice.length === 0) {
    const fallback = compatible[0] ?? { model: "unknown", provider: "unknown", capabilities: [] };
    return {
      model: fallback.model,
      provider: fallback.provider,
      tier: "balanced",
      reason: "Nenhum modelo com preço conhecido — fallback",
    };
  }

  withPrice.sort((a, b) => (a.price!.inputPer1M + a.price!.outputPer1M) - (b.price!.inputPer1M + b.price!.outputPer1M));

  let tier: ModelTier;
  let reason: string;

  if (energy.riskLevel === "high") {
    tier = "cheap";
    reason = `Orçamento crítico (${Math.round(energy.budgetAvailable * 100) / 100} USD restantes) — usando modelo barato`;
  } else if (critical && withPrice.length >= 3) {
    // Passo crítico e orçamento permite — usa o mais capaz
    const choice = withPrice[withPrice.length - 1]!;
    return {
      model: choice.model,
      provider: choice.provider,
      tier: "expensive",
      reason: "Passo crítico — priorizando qualidade",
    };
  } else if (energy.efficiencyScore > 1.0 && withPrice.length >= 2) {
    // Alta eficiência → pode investir um pouco mais
    const choice = withPrice[Math.floor(withPrice.length / 2)]!;
    return {
      model: choice.model,
      provider: choice.provider,
      tier: "balanced",
      reason: "Alta eficiência — modelo equilibrado",
    };
  } else {
    tier = "balanced";
    reason = "Condições normais — modelo equilibrado";
  }

  // Seleciona o índice do modelo conforme o tier decidido
  // Nota: os branches critical/efficiency retornam cedo, então aqui o tier
  // pode ser "cheap" ou "balanced" — mas tratamos de forma defensiva.
  const tierIndex = (t: ModelTier): number => {
    if (t === "cheap") return 0;
    if (t === "expensive") return withPrice.length - 1;
    return Math.floor(withPrice.length / 2);
  };
  const index = tierIndex(tier);
  const choice = withPrice[index] ?? withPrice[0]!;
  if (!choice) {
    // Ultimate fallback
    return {
      model: "unknown",
      provider: "unknown",
      tier: "balanced",
      reason: "Nenhum modelo disponível",
    };
  }

  return {
    model: choice.model,
    provider: choice.provider,
    tier,
    reason,
  };
}

/** Obtém preço do modelo do catálogo. */
function costPriceFor(model: string, catalog: readonly ModelEntry[] = []): CostPrice | null {
  const entry = catalog.find((m) => m.model === model);
  if (!entry) return null;
  return {
    inputPer1M: entry.inputCostPer1MTokens ?? entry.costPer1MTokens,
    outputPer1M: entry.outputCostPer1MTokens ?? entry.costPer1MTokens,
  };
}