import { describe, expect, it } from "vitest";
import { analyzeTask } from "../src/adaptive/taskAnalyzer.js";
import { createProgressState } from "../src/adaptive/progressTracker.js";
import { detectCuriosity, createCuriosityState } from "../src/evolution/curiosity.js";
import type { PlanStep, Observation, ValidationResult, Decision } from "../src/adaptive/types.js";

describe("F7 — Curiosity Engine", () => {
  it("detecta tarefa repetida", () => {
    const state = createCuriosityState();
    // Simula assinaturas repetidas já no histórico
    state.recentTasks.push("geracao_codigo,raciocinio::codigo");
    state.recentTasks.push("geracao_codigo,raciocinio::codigo");

    const progress = createProgressState();
    const profile = analyzeTask("Implemente uma função que soma dois números em TypeScript");
    const signal = detectCuriosity(state, progress, [], profile, 2);

    expect(signal.shouldExplore).toBe(true);
    expect(signal.reason).toContain("Tarefa repetida");
    expect(signal.priority).toBeGreaterThan(0);
  });

  it("detecta baixa confiança em passos consecutivos", () => {
    const state = createCuriosityState();
    const progress = createProgressState();
    const profile = analyzeTask("Implemente uma função que soma dois números em TypeScript");

    const cycles: Array<{
      iteration: number; stepId: string | null; stepDescription: string;
      capability: PlanStep["capability"]; toolName: string; observation: Observation;
      validation: ValidationResult; decision: Decision; timestamp: number; durationMs: number;
    }> = [
      {
        iteration: 1, stepId: "s1", stepDescription: "Analisar", capability: "analise",
        toolName: "llm", observation: { success: false, output: null, error: "x", exitCode: 1, durationMs: 10, toolName: "llm", metadata: {} },
        validation: { passed: false, validatorType: "heuristic", confidence: 0.3, issues: ["falhou"], suggestedCorrection: null },
        decision: { action: "continue", reason: "", confidence: 0.3, metadata: {} }, timestamp: Date.now(), durationMs: 10,
      },
      {
        iteration: 2, stepId: "s2", stepDescription: "Implementar", capability: "geracao_codigo",
        toolName: "llm", observation: { success: false, output: null, error: "x", exitCode: 1, durationMs: 10, toolName: "llm", metadata: {} },
        validation: { passed: false, validatorType: "heuristic", confidence: 0.3, issues: ["falhou"], suggestedCorrection: null },
        decision: { action: "continue", reason: "", confidence: 0.3, metadata: {} }, timestamp: Date.now(), durationMs: 10,
      },
    ];

    const signal = detectCuriosity(state, progress, cycles, profile, 3);
    expect(signal.shouldExplore).toBe(true);
    expect(signal.reason).toContain("Baixa confiança");
  });

  it("retorna no-op quando não há sinais", () => {
    const state = createCuriosityState();
    const progress = createProgressState();
    const profile = analyzeTask("Ola, tudo bem?");
    const signal = detectCuriosity(state, progress, [], profile, 2);

    expect(signal.shouldExplore).toBe(false);
    expect(signal.reason).toBe("");
    expect(signal.priority).toBe(0);
  });
});