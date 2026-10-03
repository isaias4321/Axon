import { describe, expect, it } from "vitest";
import {
  DEFAULT_WEIGHTS,
  scoringWeightsFor,
} from "../src/adaptive/scoring.js";
import type { TaskProfile } from "../src/adaptive/taskAnalyzer.js";

function profile(overrides: Partial<TaskProfile>): TaskProfile {
  return {
    text: "tarefa",
    complexity: "media",
    category: "geral",
    capabilities: ["raciocinio"],
    wordCount: 2,
    charCount: 6,
    hints: [],
    ...overrides,
  };
}

describe("scoringWeightsFor", () => {
  it("soma 1.0 para toda categoria e complexidade", () => {
    for (const category of [
      "conversacao",
      "codigo",
      "analise",
      "planejamento",
      "geral",
    ] as const) {
      for (const complexity of ["baixa", "media", "alta"] as const) {
        const weights = scoringWeightsFor(
          profile({ category, complexity })
        );
        const sum =
          weights.capability +
          weights.suitability +
          weights.cost +
          weights.latency;
        expect(sum).toBeCloseTo(1.0, 5);
      }
    }
  });

  it("conversa simples prioriza custo e latência sobre capacidade", () => {
    const weights = scoringWeightsFor(
      profile({ category: "conversacao", complexity: "media" })
    );

    expect(weights.cost).toBeGreaterThan(weights.capability);
    expect(weights.latency).toBeGreaterThan(weights.capability);
  });

  it("tarefa de código prioriza capacidade", () => {
    const weights = scoringWeightsFor(
      profile({ category: "codigo", complexity: "media" })
    );

    expect(weights.capability).toBeGreaterThan(weights.cost);
    expect(weights.capability).toBeGreaterThan(weights.latency);
    expect(weights.capability).toBeGreaterThan(weights.suitability);
  });

  it("categoria geral cai no DEFAULT_WEIGHTS", () => {
    const weights = scoringWeightsFor(
      profile({ category: "geral", complexity: "media" })
    );

    expect(weights).toEqual(DEFAULT_WEIGHTS);
  });

  it("complexidade alta sobe o peso da capacidade e desce o do custo", () => {
    const media = scoringWeightsFor(
      profile({ category: "analise", complexity: "media" })
    );
    const alta = scoringWeightsFor(
      profile({ category: "analise", complexity: "alta" })
    );

    expect(alta.capability).toBeGreaterThan(media.capability);
    expect(alta.cost).toBeLessThan(media.cost);
  });

  it("complexidade baixa sobe o peso do custo e desce o da capacidade", () => {
    const media = scoringWeightsFor(
      profile({ category: "analise", complexity: "media" })
    );
    const baixa = scoringWeightsFor(
      profile({ category: "analise", complexity: "baixa" })
    );

    expect(baixa.cost).toBeGreaterThan(media.cost);
    expect(baixa.capability).toBeLessThan(media.capability);
  });

  it("capacidade nunca fica negativa mesmo com delta baixo (floor 0)", () => {
    // conversacao já tem capability 0.20; com baixa, -0.05 → 0.15, ainda >= 0.
    const weights = scoringWeightsFor(
      profile({ category: "conversacao", complexity: "baixa" })
    );

    expect(weights.capability).toBeGreaterThanOrEqual(0);
    expect(weights.cost).toBeGreaterThanOrEqual(0);
    expect(weights.latency).toBeGreaterThanOrEqual(0);
  });
});
