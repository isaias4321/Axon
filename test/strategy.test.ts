import { describe, expect, it } from "vitest";
import { createStrategyState, recordStrategyOutcome, scoreStrategies, bestStrategy } from "../src/evolution/strategy.js";

describe("F7 — Strategy Evolution", () => {
  it("registra outcomes e calcula scores", () => {
    const state = createStrategyState();

    recordStrategyOutcome(state, "single_agent", true, 5, 100);
    recordStrategyOutcome(state, "single_agent", true, 3, 50);
    recordStrategyOutcome(state, "multi_agent", false, 10, 200);

    const scores = scoreStrategies(state);
    expect(scores.length).toBe(2);
    expect(scores[0]!.sampleCount).toBeGreaterThanOrEqual(1);
    expect(scores[0]!.successRate).toBeGreaterThanOrEqual(0);
  });

  it("single_agent com mais sucesso tem prioridade", () => {
    const state = createStrategyState();
    // A: 100 execuções, 80 sucessos
    for (let i = 0; i < 100; i++) {
      recordStrategyOutcome(state, "single_agent", i < 80, 1, 10);
    }
    // B: 100 execuções, 45 sucessos
    for (let i = 0; i < 100; i++) {
      recordStrategyOutcome(state, "autonomous", i < 45, 2, 20);
    }

    const scores = scoreStrategies(state);
    const a = scores.find((s) => s.strategy === "single_agent")!;
    const b = scores.find((s) => s.strategy === "autonomous")!;
    expect(a.successRate).toBeCloseTo(0.8, 5);
    expect(b.successRate).toBeCloseTo(0.45, 5);
    expect(a.successRate).toBeGreaterThan(b.successRate);
  });

  it("bestStrategy retorna a melhor com minSamples", () => {
    const state = createStrategyState();
    recordStrategyOutcome(state, "single_agent", true, 5, 100);
    recordStrategyOutcome(state, "single_agent", true, 3, 50);
    recordStrategyOutcome(state, "multi_agent", false, 10, 200);

    const best = bestStrategy(state, 2);
    expect(best).toBe("single_agent");
  });

  it("bestStrategy retorna null sem samples suficientes", () => {
    const state = createStrategyState();
    recordStrategyOutcome(state, "single_agent", true, 5, 100);
    const best = bestStrategy(state, 3);
    expect(best).toBeNull();
  });
});