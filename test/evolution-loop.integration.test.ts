import { describe, expect, it } from "vitest";
import { analyzeTask } from "../src/adaptive/taskAnalyzer.js";
import { createProgressState } from "../src/adaptive/progressTracker.js";
import { BudgetManager } from "../src/adaptive/budget.js";
import { detectCuriosity, createCuriosityState } from "../src/evolution/curiosity.js";
import { generateGoals } from "../src/evolution/goals.js";
import { computeEnergyState, chooseModelTier } from "../src/evolution/metabolism.js";
import { createSkillsState, updateSkill, getSkills, leastConfidentSkill } from "../src/evolution/skills.js";
import { createStrategyState, recordStrategyOutcome, bestStrategy } from "../src/evolution/strategy.js";
import { reflect } from "../src/evolution/reflection.js";
import type { CycleLog, ValidationResult, Decision, Observation } from "../src/adaptive/types.js";
import type { AutonomousBudgets } from "../src/adaptive/types.js";

/**
 * Teste de integração da Fase 7 — "nível de inteligência do agente".
 *
 * Simula um agente que FALHA repetidamente numa capacidade, e verifica se a
 * camada de evolução reage como um sistema cognitivo:
 *  1. Curiosidade DETECTA o padrão de falha
 *  2. Gera OBJETIVOS internos (improve/learn/optimize)
 *  3. Metabolismo ajusta modelo (risco)
 *  4. Skills ABANDONAM a capacidade ruim (menor confiança)
 *  5. Estratégia re-ranqueia com histórico
 *  6. Reflexão EXTRAI lições pós-execução
 */

function makeObservation(success: boolean, error: string | null): Observation {
  return {
    success,
    output: success ? "ok" : null,
    error,
    exitCode: success ? 0 : 1,
    durationMs: 10,
    toolName: "llm",
    metadata: {},
  };
}

function makeValidation(passed: boolean, confidence: number, issues: string[]): ValidationResult {
  return { passed, validatorType: "heuristic", confidence, issues, suggestedCorrection: null };
}

function makeDecision(action: Decision["action"], confidence: number): Decision {
  return { action, reason: "", confidence, metadata: {} };
}

function makeCycle(
  stepId: string,
  desc: string,
  cap: CycleLog["capability"],
  obs: Observation,
  val: ValidationResult,
  dec: Decision
): CycleLog {
  return {
    iteration: 1, stepId, stepDescription: desc, capability: cap, toolName: "llm",
    observation: obs, validation: val, decision: dec,
    timestamp: Date.now(), durationMs: 10,
  };
}

const CATALOG = [
  { provider: "gemini", model: "flash", complexitySuitability: ["baixa", "media", "alta"], costPer1MTokens: 0.1, inputCostPer1MTokens: 0.1, outputCostPer1MTokens: 0.1, latencyTier: "baixo", capabilities: ["geracao_codigo"], notes: "" },
  { provider: "gemini", model: "pro", complexitySuitability: ["baixa", "media", "alta"], costPer1MTokens: 0.3, inputCostPer1MTokens: 0.3, outputCostPer1MTokens: 0.3, latencyTier: "medio", capabilities: ["geracao_codigo"], notes: "" },
  { provider: "gemini", model: "ultra", complexitySuitability: ["baixa", "media", "alta"], costPer1MTokens: 1.0, inputCostPer1MTokens: 1.0, outputCostPer1MTokens: 1.0, latencyTier: "alto", capabilities: ["geracao_codigo"], notes: "" },
];

describe("F7 — Nível de inteligência (loop de evolução integrado)", () => {
  it("1. Curiosity DETECTA padrão de erro recorrente", () => {
    const state = createCuriosityState();
    const progress = createProgressState();
    const profile = analyzeTask("Implemente uma função de ordenação em TypeScript");

    const cycles: CycleLog[] = [];
    for (let i = 0; i < 3; i++) {
      const obs = makeObservation(false, "Erro de sintaxe: esperado '}'");
      const val = makeValidation(false, 0.3, ["falhou"]);
      cycles.push(makeCycle("s1", `Tentativa ${i + 1}`, "geracao_codigo", obs, val, makeDecision("correct", 0.3)));
      if (obs.error) {
        const key = obs.error.substring(0, 100);
        progress.errorCounts.set(key, (progress.errorCounts.get(key) ?? 0) + 1);
      }
    }

    const signal = detectCuriosity(state, progress, cycles, profile, 2);
    expect(signal.shouldExplore).toBe(true);
    // A detecção é por prioridade de gatilhos; com 3 erros repetidos dispara
    // "Baixa confiança" (2 passos consecutivos), ou "Erro recorrente" se o
    // limiar de erros for >= threshold. O importante é detectar.
    expect(signal.reason.length).toBeGreaterThan(0);
    expect(signal.priority).toBeGreaterThan(0);
  });

  it("2. Curiosity → Gerador de OBJETIVOS", () => {
    const signal = { shouldExplore: true, reason: "Baixo desempenho em geracao_codigo", priority: 0.8, suggestedKnowledge: "geracao_codigo" };
    const profile = analyzeTask("Implemente uma função de ordenação");

    const goals = generateGoals(signal, profile);
    expect(goals.length).toBe(3);
    const types = goals.map((g) => g.type);
    expect(types).toContain("improve");
    expect(types).toContain("learn");
    expect(types).toContain("optimize");
    const improve = goals.find((g) => g.type === "improve")!;
    expect(improve.priority).toBeGreaterThan(0.7);
  });

  it("3. Metabolismo gera estado energético e ajusta modelo conforme risco", () => {
    const budgets: AutonomousBudgets = { maxIterations: 10, maxCostUsd: 1, maxDurationMs: 10000, maxTokens: 1000 };
    const bm = new BudgetManager(budgets);

    const low = computeEnergyState(budgets, bm, { snapshots: [], efficiencyHistory: [] });
    expect(low.riskLevel).toBe("low");

    bm.recordToolCall(0.95, 950);
    const high = computeEnergyState(budgets, bm, { snapshots: [], efficiencyHistory: [] });
    expect(high.riskLevel).toBe("high");

    const profile = analyzeTask("Implemente uma função de ordenação");
    const choice = chooseModelTier(high, profile, CATALOG, false);
    expect(choice.tier).toBe("cheap");
    expect(choice.model).toBe("flash");

    const lowChoice = chooseModelTier(low, profile, CATALOG, true);
    expect(lowChoice.tier).toBe("expensive");
  });

  it("4. Skills rastreiam sucesso e apontam capacidade fraca", () => {
    const state = createSkillsState();
    for (let i = 0; i < 10; i++) updateSkill(state, "analise", i < 9, `ana ${i}`);
    for (let i = 0; i < 10; i++) updateSkill(state, "geracao_codigo", i < 2, `gen ${i}`);

    const skills = getSkills(state);
    const gen = skills.find((s) => s.name === "geracao_codigo")!;
    const ana = skills.find((s) => s.name === "analise")!;

    expect(gen.successRate).toBeCloseTo(0.2, 5);
    expect(ana.successRate).toBeCloseTo(0.9, 5);
    const weak = leastConfidentSkill(state, "geracao_codigo")!;
    expect(weak.successRate).toBeLessThan(0.5);
  });

  it("5. Evolução de estratégias re-ranqueia pelo histórico", () => {
    const state = createStrategyState();
    for (let i = 0; i < 100; i++) recordStrategyOutcome(state, "single_agent", i < 80, 1, 10);
    for (let i = 0; i < 100; i++) recordStrategyOutcome(state, "autonomous", i < 45, 2, 20);

    const best = bestStrategy(state, 10);
    expect(best).toBe("single_agent");
  });

  it("6. Reflexão extrai PLANO_FALHOU, passo_falho e conhecimento_faltante", () => {
    const logs: CycleLog[] = [
      makeCycle("s1", "Buscar dados", "analise", makeObservation(true, null), makeValidation(true, 0.9, []), makeDecision("continue", 0.9)),
      makeCycle("s2", "Implementar ordenação", "geracao_codigo", makeObservation(false, "falha"), makeValidation(false, 0.2, ["não sabe ordenação"]), makeDecision("correct", 0.2)),
    ];

    const reflection = reflect(undefined, logs);
    expect(reflection.plan_worked).toBe(0);
    expect(reflection.failed_step).toBe("Implementar ordenação");
    expect(reflection.improvement_suggestion).toContain("corre");
    expect(reflection.lessons.length).toBeGreaterThan(0);
  });

  it("7. LOOP COMPLETO: falhas → curiosidade → objetivos → reflexão (agente 'aprende')", () => {
    const progress = createProgressState();
    const curiosityState = createCuriosityState();
    const skillsState = createSkillsState();
    const strategyState = createStrategyState();
    const profile = analyzeTask("Implemente uma função de ordenação");

    const cycles: CycleLog[] = [];
    for (let i = 0; i < 3; i++) {
      const obs = makeObservation(false, "falha de compilação");
      const val = makeValidation(false, 0.3, ["erro"]);
      cycles.push(makeCycle("s1", `Implementar (tentativa ${i + 1})`, "geracao_codigo", obs, val, makeDecision("correct", 0.3)));
      progress.errorCounts.set("falha", (progress.errorCounts.get("falha") ?? 0) + 1);
      updateSkill(skillsState, "geracao_codigo", false, "Implementar");
    }
    recordStrategyOutcome(strategyState, "autonomous", false, 10, 100);

    const signal = detectCuriosity(curiosityState, progress, cycles, profile, 2);
    expect(signal.shouldExplore).toBe(true);

    const goals = generateGoals(signal, profile);
    expect(goals.length).toBe(3);

    const weak = leastConfidentSkill(skillsState, "geracao_codigo")!;
    expect(weak.successRate).toBe(0);

    const bestStrat = bestStrategy(strategyState, 1);
    expect(bestStrat).toBe("autonomous");

    const reflection = reflect(undefined, cycles);
    expect(reflection.plan_worked).toBe(0);
    expect(reflection.failed_step).toContain("Implementar");
    expect(reflection.lessons.length).toBeGreaterThan(0);
  });
});