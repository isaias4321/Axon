import { describe, expect, it } from "vitest";
import { reflect } from "../src/evolution/reflection.js";
import type { CycleLog } from "../src/adaptive/types.js";

function makeSlice(stepDescription: string, passed: boolean, confidence: number, issues: string[]): CycleLog {
  return {
    iteration: 1,
    stepId: "s",
    stepDescription,
    capability: "geracao_codigo",
    toolName: "llm",
    observation: { success: passed, output: passed ? "ok" : null, error: passed ? null : "err", exitCode: passed ? 0 : 1, durationMs: 10, toolName: "llm", metadata: {} },
    validation: { passed, validatorType: "heuristic", confidence, issues, suggestedCorrection: null },
    decision: { action: "continue", reason: "", confidence, metadata: {} },
    timestamp: Date.now(),
    durationMs: 10,
  };
}

describe("F7 — Self Reflection Loop", () => {
  it("reflete execução totalmente bem-sucedida", () => {
    const logs = [
      makeSlice("Analisar", true, 0.9, []),
      makeSlice("Implementar", true, 0.9, []),
    ];
    const result = reflect(undefined, logs);
    expect(result.plan_worked).toBe(1);
    expect(result.failed_step).toBeNull();
    expect(result.lessons.length).toBeGreaterThan(0);
  });

  it("detecta passo que falhou", () => {
    const logs = [
      makeSlice("Analisar", true, 0.9, []),
      makeSlice("Implementar", false, 0.3, ["erro de codificação"]),
    ];
    const result = reflect(undefined, logs);
    expect(result.plan_worked).toBe(0);
    expect(result.failed_step).toBe("Implementar");
    expect(result.lessons.length).toBeGreaterThan(0);
  });

  it("gera sugestão de melhoria baseada em correções", () => {
    const log = makeSlice("Implementar", true, 0.9, []);
    const corrected: CycleLog = { ...log, decision: { action: "correct", reason: "baixa confiança", confidence: 0.4, metadata: {} } };
    const result = reflect(undefined, [corrected]);
    expect(result.improvement_suggestion).toContain("corre");
  });

  it("detecta conhecimento faltante em baixa confiança", () => {
    const logs = [
      makeSlice("Implementar", false, 0.2, ["não entendi"]),
      makeSlice("Validar", true, 0.9, []),
    ];
    const result = reflect(undefined, logs);
    expect(result.missing_knowledge).toBeDefined();
    expect(result.lessons.length).toBeGreaterThan(0);
  });
});