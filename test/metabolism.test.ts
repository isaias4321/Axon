import { describe, expect, it } from "vitest";
import { computeEnergyState, chooseModelTier } from "../src/evolution/metabolism.js";
import { BudgetManager } from "../src/adaptive/budget.js";
import { analyzeTask } from "../src/adaptive/taskAnalyzer.js";
import type { AutonomousBudgets } from "../src/adaptive/types.js";
import type { ModelEntry } from "../src/adaptive/modelCatalog.js";
import type { EnergyState, MetabolismState } from "../src/evolution/types.js";

function makeBudgets(): AutonomousBudgets {
  return { maxIterations: 10, maxCostUsd: 1, maxDurationMs: 10000, maxToolCalls: 20, maxTokens: 1000 };
}

function makeMetab(): MetabolismState {
  return { snapshots: [], efficiencyHistory: [] };
}

const CATALOG: ModelEntry[] = [
  { provider: "gemini", model: "gemini-flash", complexitySuitability: ["baixa", "media", "alta"], costPer1MTokens: 0.1, inputCostPer1MTokens: 0.1, outputCostPer1MTokens: 0.1, latencyTier: "baixo", capabilities: ["geracao_codigo"], notes: "" },
  { provider: "gemini", model: "gemini-pro", complexitySuitability: ["baixa", "media", "alta"], costPer1MTokens: 0.3, inputCostPer1MTokens: 0.3, outputCostPer1MTokens: 0.3, latencyTier: "medio", capabilities: ["geracao_codigo"], notes: "" },
  { provider: "gemini", model: "gemini-ultra", complexitySuitability: ["baixa", "media", "alta"], costPer1MTokens: 1.0, inputCostPer1MTokens: 1.0, outputCostPer1MTokens: 1.0, latencyTier: "alto", capabilities: ["geracao_codigo"], notes: "" },
];

describe("F7 — Metabolism Manager", () => {
  it("calcula estado energético com orçamento saudável", () => {
    const bm = new BudgetManager(makeBudgets());
    const energy = computeEnergyState(makeBudgets(), bm, makeMetab());
    expect(energy.riskLevel).toBe("low");
    expect(energy.tokensAvailable).toBe(1000);
    expect(energy.budgetAvailable).toBeGreaterThan(0);
  });

  it("calcula estado com orçamento baixo (high risk)", () => {
    const budgets = { ...makeBudgets(), maxCostUsd: 0.1 };
    const bm = new BudgetManager(budgets);
    bm.recordToolCall(0.09, 900); // consome quase tudo
    const energy = computeEnergyState(budgets, bm, makeMetab());
    expect(energy.riskLevel).toBe("high");
  });

  it("escolhe modelo barato em alto risco", () => {
    const energy: EnergyState = { tokensAvailable: 100, budgetAvailable: 0.01, efficiencyScore: 0.5, riskLevel: "high" };
    const profile = analyzeTask("Implemente uma função em TypeScript");
    const choice = chooseModelTier(energy, profile, CATALOG, false);
    expect(choice.tier).toBe("cheap");
    expect(choice.model).toBe("gemini-flash");
  });

  it("escolhe modelo caro quando passo é crítico", () => {
    const energy: EnergyState = { tokensAvailable: 100, budgetAvailable: 50, efficiencyScore: 1.5, riskLevel: "low" };
    const profile = analyzeTask("Implemente uma função em TypeScript");
    const choice = chooseModelTier(energy, profile, CATALOG, true);
    expect(choice.tier).toBe("expensive");
    expect(choice.model).toBe("gemini-ultra");
  });

  it("escolhe modelo equilibrado em condições normais", () => {
    const energy: EnergyState = { tokensAvailable: 100, budgetAvailable: 50, efficiencyScore: 0.5, riskLevel: "low" };
    const profile = analyzeTask("Implemente uma função em TypeScript");
    const choice = chooseModelTier(energy, profile, CATALOG, false);
    expect(choice.tier).toBe("balanced");
  });
});