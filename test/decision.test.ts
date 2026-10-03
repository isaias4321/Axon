import { describe, expect, it } from "vitest";
import { decideNextAction, applyCorrection, replan } from "../src/adaptive/decision.js";
import { analyzeTask } from "../src/adaptive/taskAnalyzer.js";
import type { Plan, PlanStep, Observation, ValidationResult } from "../src/adaptive/types.js";
import type { ProviderAdapter } from "../src/providers/types.js";

interface MinimalProvider {
  name: ProviderAdapter["name"];
  complete: () => Promise<unknown>;
  stream: () => Promise<unknown>;
}

function makeStep(id: string, capability: PlanStep["capability"], status: PlanStep["status"] = "pending"): PlanStep {
  return {
    id,
    index: 0,
    description: `Etapa ${id}`,
    objective: "Obj",
    capability,
    dependencies: [],
    status,
    attempts: 0,
    maxAttempts: 3,
  };
}

function makeObservation(success: boolean): Observation {
  return {
    success,
    output: success ? "resultado" : null,
    error: success ? null : "erro",
    exitCode: success ? 0 : 1,
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
    issues: passed ? [] : ["falhou"],
    suggestedCorrection: passed ? null : "tente de novo",
  };
}

function makePlan(steps: PlanStep[]): Plan {
  return {
    id: "plan-1",
    steps,
    nextStepId: steps.find((s) => s.status === "pending")?.id ?? null,
  };
}

const TASK = "Em modo autonomo, implemente uma função";
const profile = analyzeTask(TASK);

describe("DecisionEngine", () => {
  it("CONTINUE quando validação passa e há próxima etapa", () => {
    const step1 = makeStep("s1", "analise", "running");
    const step2 = makeStep("s2", "geracao_codigo");
    const plan = makePlan([step1, step2]);

    const decision = decideNextAction({
      step: step1,
      observation: makeObservation(true),
      validation: makeValidation(true),
      plan,
      profile,
      consecutiveFailures: 0,
      noProgressThreshold: 3,
      enableCorrection: true,
      enableReplanning: true,
      retrievedMemory: [],
    });

    expect(decision.action).toBe("continue");
  });

  it("FINISH_SUCCESS quando todas as etapas completadas", () => {
    const step1 = makeStep("s1", "analise", "running");
    const plan = makePlan([step1]);

    const decision = decideNextAction({
      step: step1,
      observation: makeObservation(true),
      validation: makeValidation(true),
      plan,
      profile,
      consecutiveFailures: 0,
      noProgressThreshold: 3,
      enableCorrection: true,
      enableReplanning: true,
      retrievedMemory: [],
    });

    expect(decision.action).toBe("finish");
    expect(decision.metadata.terminationReason).toBe("success");
  });

  it("CORRECT quando validação falha e há attempts disponíveis", () => {
    const step1 = makeStep("s1", "analise", "running");
    step1.attempts = 1;
    const plan = makePlan([step1]);

    const decision = decideNextAction({
      step: step1,
      observation: makeObservation(false),
      validation: makeValidation(false),
      plan,
      profile,
      consecutiveFailures: 1,
      noProgressThreshold: 3,
      enableCorrection: true,
      enableReplanning: true,
      retrievedMemory: [],
    });

    expect(decision.action).toBe("correct");
  });

  it("REPLAN quando validação falha e sem attempts (max atingido)", () => {
    const step1 = makeStep("s1", "analise", "running");
    step1.attempts = 3;
    const plan = makePlan([step1]);

    const decision = decideNextAction({
      step: step1,
      observation: makeObservation(false),
      validation: makeValidation(false),
      plan,
      profile,
      consecutiveFailures: 1,
      noProgressThreshold: 3,
      enableCorrection: true,
      enableReplanning: true,
      retrievedMemory: [],
    });

    expect(decision.action).toBe("replan");
  });

  it("FINISH_FAILURE quando correction desabilitado e validação falha", () => {
    const step1 = makeStep("s1", "analise", "running");
    const plan = makePlan([step1]);

    const decision = decideNextAction({
      step: step1,
      observation: makeObservation(false),
      validation: makeValidation(false),
      plan,
      profile,
      consecutiveFailures: 1,
      noProgressThreshold: 3,
      enableCorrection: false,
      enableReplanning: false,
      retrievedMemory: [],
    });

    expect(decision.action).toBe("finish");
    expect(decision.metadata.terminationReason).toBe("failure");
  });

  it("FINISH no_progress quando falhas consecutivas >= threshold", () => {
    const step1 = makeStep("s1", "analise", "running");
    const plan = makePlan([step1]);

    const decision = decideNextAction({
      step: step1,
      observation: makeObservation(false),
      validation: makeValidation(false),
      plan,
      profile,
      consecutiveFailures: 3,
      noProgressThreshold: 3,
      enableCorrection: true,
      enableReplanning: true,
      retrievedMemory: [],
    });

    expect(decision.action).toBe("finish");
    expect(decision.metadata.terminationReason).toBe("no_progress");
  });
});

describe("applyCorrection", () => {
  it("incrementa attempts e marca pending", () => {
    const step = makeStep("s1", "analise", "failed");
    step.attempts = 1;
    const plan = makePlan([step]);

    const record = applyCorrection(plan, "s1", "Use abordagem X", "falhou");

    expect(plan.steps[0]!.attempts).toBe(2);
    expect(plan.steps[0]!.status).toBe("pending");
    expect(record.correctedStep.description).toContain("abordagem X");
  });
});

describe("replan", () => {
  it("gera novo plano preservando etapas completadas", async () => {
    const completed = makeStep("s1", "analise", "completed");
    completed.result = "Análise feita";
    const failed = makeStep("s2", "geracao_codigo", "failed");
    const plan = makePlan([completed, failed]);

    const { newPlan, replanRecord } = await replan(
      TASK,
      profile,
      plan,
      "s2",
      undefined,
      buildMinimalProviders(),
      "gemini",
      "gemini-2.5-flash",
      [],
      10
    );

    // Etapa completada deve ser preservada
    expect(newPlan.steps.some((s) => s.id === "s1")).toBe(true);
    // Deve haver pelo menos uma etapa pending
    expect(newPlan.steps.some((s) => s.status === "pending")).toBe(true);
    expect(replanRecord.replacedStepIds).toContain("s2");
  });
});

function buildMinimalProviders(): Map<string, MinimalProvider> {
  return new Map([["gemini", { name: "gemini" as const, complete: async () => ({}), stream: async () => ({}) }]]);
}
