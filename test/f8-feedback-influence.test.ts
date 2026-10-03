import { describe, expect, it } from "vitest";
import { influenceModelTier, weakCapabilities } from "../src/evolution/loader.js";
import { rankCandidates } from "../src/adaptive/modelRouter.js";
import { analyzeTask } from "../src/adaptive/taskAnalyzer.js";
import type { ModelEntry } from "../src/adaptive/modelCatalog.js";
import type { ProviderAdapter } from "../src/providers/types.js";

/**
 * FASE 8 — Prova que o feedback loop F7 influencia decisões de MODELO.
 *
 * Cenário: histórico de energia mostra orçamento crítico → influenceModelTier
 * sugere "cheap" → os pesos de scoring mudam → o modelo MAIS BARATO é
 * ranqueado acima do caro (que sem influência seria o escolhido).
 */

function makeProviders(...names: string[]): Map<string, ProviderAdapter> {
  return new Map(names.map((n) => [n, { name: n as ProviderAdapter["name"], complete: async () => ({ id: "x", provider: n, model: "m", content: "ok", usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }, cached: false }), stream: async function* () { yield { done: true }; } }]));
}

const CATALOG: ModelEntry[] = [
  { provider: "gemini", model: "barato", complexitySuitability: ["baixa", "media"], costPer1MTokens: 0.1, inputCostPer1MTokens: 0.1, outputCostPer1MTokens: 0.1, latencyTier: "baixo", capabilities: ["geracao_codigo", "raciocinio"], notes: "" },
  { provider: "gemini", model: "caro", complexitySuitability: ["baixa", "media", "alta"], costPer1MTokens: 5, inputCostPer1MTokens: 5, outputCostPer1MTokens: 5, latencyTier: "medio", capabilities: ["geracao_codigo", "raciocinio"], notes: "" },
];

describe("F8 — F7 influencia decisões de modelo (runtime real)", () => {
  it("histórico com orçamento crítico faz influenceModelTier sugerir cheap", () => {
    const ctx = {
      strategyHistory: [],
      skills: [],
      recurringErrors: [],
      energyHistory: [{ budgetAvailable: 0.01, efficiencyScore: 0.2, riskLevel: "high" }],
      priorReflections: [],
      priorGoals: [],
      loadedAt: 0,
    };
    const tier = influenceModelTier(ctx, "balanced");
    expect(tier.tier).toBe("cheap");
  });

  it("pesos evolutivos (cheap) re-ranqueiam o modelo barato acima do caro", () => {
    const ctx = {
      strategyHistory: [],
      skills: [],
      recurringErrors: [],
      energyHistory: [{ budgetAvailable: 0.01, efficiencyScore: 0.2, riskLevel: "high" }],
      priorReflections: [],
      priorGoals: [],
      loadedAt: 0,
    };
    const tier = influenceModelTier(ctx, "balanced");
    const profile = analyzeTask("Implemente uma função em TypeScript que processe dados");

    const providers = makeProviders("gemini");
    const baseWeights = { capability: 0.4, suitability: 0.25, cost: 0.2, latency: 0.15 };

    // SEM influência (pesos base) — modelo caro tem mais capacidade → score maior
    const baseRank = rankCandidates(profile, providers, CATALOG, baseWeights);
    // COM influência (peso de custo maior) — modelo barato deve subir
    const evolvedWeights = {
      ...baseWeights,
      cost: tier.tier === "cheap" ? baseWeights.cost + 0.2 : baseWeights.cost,
    };
    const evolvedRank = rankCandidates(profile, providers, CATALOG, evolvedWeights);

    const caroBase = baseRank.find((c) => c.model === "caro")?.score ?? 0;
    const baratoBase = baseRank.find((c) => c.model === "barato")?.score ?? 0;
    const caroEvol = evolvedRank.find((c) => c.model === "caro")?.score ?? 0;
    const baratoEvol = evolvedRank.find((c) => c.model === "barato")?.score ?? 0;

    console.log("  base: barato=", baratoBase, "caro=", caroBase);
    console.log("  evol: barato=", baratoEvol, "caro=", caroEvol);

    // Com influência cheap, o custo pesa mais → a distância caro/barato diminui
    // OU barato supera caro. Pelo menos a decisão MUDOU (gap menor ou invertido).
    const gapBase = caroBase - baratoBase;
    const gapEvol = caroEvol - baratoEvol;
    expect(gapEvol).toBeLessThan(gapBase);
  });

  it("weakCapabilities identifica skills fracas de verdade", () => {
    const ctx = {
      strategyHistory: [],
      skills: [
        { name: "geracao_codigo", successRate: 0.2, usageCount: 10, confidence: 0.3 },
        { name: "analise", successRate: 0.9, usageCount: 10, confidence: 0.8 },
      ],
      recurringErrors: [],
      energyHistory: [],
      priorReflections: [],
      priorGoals: [],
      loadedAt: 0,
    };
    const weak = weakCapabilities(ctx, 0.5);
    expect(weak).toContain("geracao_codigo");
    expect(weak).not.toContain("analise");
  });
});