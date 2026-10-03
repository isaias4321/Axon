import { describe, expect, it } from "vitest";
import { generateGoals } from "../src/evolution/goals.js";
import { analyzeTask } from "../src/adaptive/taskAnalyzer.js";

describe("F7 — Goal Generator", () => {
  it("gera objetivos quando há sinal de curiosidade", () => {
    const signal = { shouldExplore: true, reason: "Baixo desempenho em SQL", priority: 0.8, suggestedKnowledge: "SQL" };
    const profile = analyzeTask("Implemente uma consulta SQL");

    const goals = generateGoals(signal, profile);

    expect(goals.length).toBeGreaterThan(0);
    expect(goals.length).toBeLessThanOrEqual(3);
    expect(goals.some((g) => g.type === "improve")).toBe(true);
    expect(goals.some((g) => g.type === "learn")).toBe(true);
    expect(goals.some((g) => g.type === "optimize")).toBe(true);
    expect(goals[0]!.description).toContain("SQL");
    expect(goals[0]!.priority).toBeGreaterThan(0);
    expect(goals[0]!.id).toBeDefined();
  });

  it("retorna array vazio quando não há curiosidade", () => {
    const signal = { shouldExplore: false, reason: "", priority: 0, suggestedKnowledge: "" };
    const profile = analyzeTask("Ola");

    const goals = generateGoals(signal, profile);
    expect(goals).toEqual([]);
  });
});