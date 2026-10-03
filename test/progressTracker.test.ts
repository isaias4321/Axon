import { describe, expect, it } from "vitest";
import {
  createProgressState,
  detectNoProgress,
  recordCycle,
  hashToolInput,
  generateObservabilitySummary,
} from "../src/adaptive/progressTracker.js";
import type { PlanStep, Observation, ValidationResult, Decision } from "../src/adaptive/types.js";

function makeStep(id: string): PlanStep {
  return {
    id,
    index: 0,
    description: `Etapa ${id}`,
    objective: "Obj",
    capability: "analise",
    dependencies: [],
    status: "running",
    attempts: 1,
    maxAttempts: 3,
  };
}

function makeObservation(error: string | null): Observation {
  return {
    success: error === null,
    output: error === null ? "ok" : null,
    error,
    exitCode: error === null ? 0 : 1,
    durationMs: 100,
    toolName: "llm:gemini",
    metadata: {},
  };
}

function makeValidation(passed: boolean): ValidationResult {
  return {
    passed,
    validatorType: "heuristic",
    confidence: 0.9,
    issues: [],
    suggestedCorrection: null,
  };
}

function makeDecision(action: Decision["action"]): Decision {
  return { action, reason: "r", confidence: 0.9, metadata: {} };
}

describe("ProgressTracker", () => {
  it("detecta mesmo erro repetido", () => {
    const state = createProgressState();
    const step = makeStep("s1");
    const obs = makeObservation("Erro de sintaxe X");

    const r1 = detectNoProgress(state, step, obs, "hash1", 3);
    const r2 = detectNoProgress(state, step, obs, "hash1", 3);
    const r3 = detectNoProgress(state, step, obs, "hash1", 3);

    expect(r1.detected).toBe(false);
    expect(r2.detected).toBe(false);
    expect(r3.detected).toBe(true);
    expect(r3.reason).toContain("Mismo erro");
  });

  it("detecta mesma tool call repetida", () => {
    const state = createProgressState();
    const step = makeStep("s1");
    const obs = makeObservation(null); // success, mas mesma hash

    const r1 = detectNoProgress(state, step, obs, "same-input", 2);
    const r2 = detectNoProgress(state, step, obs, "same-input", 2);

    expect(r1.detected).toBe(false);
    expect(r2.detected).toBe(true);
  });

  it("não detecta progresso quando há sucesso", () => {
    const state = createProgressState();
    const step = makeStep("s1");
    const obs = makeObservation(null); // success

    const r = detectNoProgress(state, step, obs, "diff-input-1", 3);
    expect(r.detected).toBe(false);
    expect(state.iterationsWithoutProgress).toBe(0);
  });

  it("registra ciclo para observabilidade sem expor output completo", () => {
    const state = createProgressState();
    const step = makeStep("s1");
    const obs = makeObservation(null);
    obs.output = "x".repeat(600); // muito longo
    const validation = makeValidation(true);
    const decision = makeDecision("continue");

    recordCycle(state, 1, step, obs, validation, decision, 100);

    expect(state.cycleLogs).toHaveLength(1);
    const log = state.cycleLogs[0]!;
    expect(log.observation.output).toContain("[truncado]");
    expect(log.observation.output!.length).toBeLessThanOrEqual(520);
  });

  it("gera resumo de observabilidade", () => {
    const state = createProgressState();
    const step = makeStep("s1");
    const obs = makeObservation(null);
    const validation = makeValidation(true);

    recordCycle(state, 1, step, obs, validation, makeDecision("continue"), 100);
    recordCycle(state, 2, step, obs, validation, makeDecision("finish"), 100);

    const summary = generateObservabilitySummary(state);
    expect(summary.totalCycles).toBe(2);
    expect(summary.decisions.continue).toBe(1);
    expect(summary.decisions.finish).toBe(1);
  });

  it("hashToolInput é determinístico", () => {
    const h1 = hashToolInput({ a: 1, b: 2 });
    const h2 = hashToolInput({ a: 1, b: 2 });
    const h3 = hashToolInput({ a: 2, b: 1 });
    expect(h1).toBe(h2);
    expect(h1).not.toBe(h3);
  });
});
