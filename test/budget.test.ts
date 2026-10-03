import { describe, expect, it } from "vitest";
import { BudgetManager } from "../src/adaptive/budget.js";
import type { AutonomousBudgets } from "../src/adaptive/types.js";

describe("BudgetManager", () => {
  const budgets: AutonomousBudgets = {
    maxIterations: 3,
    maxCostUsd: 0.10,
    maxDurationMs: 1000,
    maxToolCalls: 5,
    maxTokens: 1000,
  };

  it("permite execução dentro dos limites", () => {
    const bm = new BudgetManager(budgets);
    const check = bm.check();
    expect(check.exceeded).toBe(false);
    expect(check.reason).toBeNull();
  });

  it("detecta max_iterations", () => {
    const bm = new BudgetManager(budgets);
    bm.startIteration();
    bm.startIteration();
    bm.startIteration();
    const check = bm.check();
    expect(check.exceeded).toBe(true);
    expect(check.reason).toBe("max_iterations");
  });

  it("detecta max_cost", () => {
    const bm = new BudgetManager(budgets);
    bm.consume(0.10);
    const check = bm.check();
    expect(check.exceeded).toBe(true);
    expect(check.reason).toBe("max_cost");
  });

  it("detecta max_tool_calls", () => {
    const bm = new BudgetManager(budgets);
    for (let i = 0; i < 5; i++) bm.recordToolCall();
    const check = bm.check();
    expect(check.exceeded).toBe(true);
    expect(check.reason).toBe("max_tool_calls");
  });

  it("detecta max_tokens", () => {
    const bm = new BudgetManager(budgets);
    bm.consume(0, 1000);
    const check = bm.check();
    expect(check.exceeded).toBe(true);
    expect(check.reason).toBe("max_tokens");
  });

  it("calcula remaining corretamente", () => {
    const bm = new BudgetManager(budgets);
    bm.startIteration();
    bm.recordToolCall(0.01, 100);
    const check = bm.check();
    expect(check.remaining.iterations).toBe(2);
    expect(check.remaining.toolCalls).toBe(4);
    expect(check.remaining.costUsd).toBeCloseTo(0.09);
    expect(check.remaining.tokens).toBe(900);
  });
});
