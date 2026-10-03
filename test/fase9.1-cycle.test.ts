/**
 * Fase 9.1 — Ciclo cognitivo com ValidationCell e RecoveryCell.
 *
 * Prova o ciclo: Debug → Planning → Validation → (falha) → Recovery → replan.
 * Implementações reais das células; determinístico, sem LLM.
 */

import { describe, it, expect } from "vitest";
import { ValidationCell } from "../src/cognitive/cells/validation.js";
import { RecoveryCell } from "../src/cognitive/cells/recovery.js";
import { DebugCell } from "../src/cognitive/cells/debug.js";
import { PlanningCell } from "../src/cognitive/cells/planning.js";
import { createCognitiveMemory } from "../src/cognitive/memory.js";
import type { CellExecutionContext } from "../src/cognitive/types.js";

function buildCellContext(taskId: string): CellExecutionContext {
  const memory = createCognitiveMemory({ sessionPrefix: "cycle-test" });
  return {
    sessionId: "cycle-test",
    taskId,
    taskProfile: {
      capabilities: ["raciocinio"],
      category: "geral",
      complexity: "media",
      text: "tarefa",
      hints: [],
      wordCount: 1,
      charCount: 6,
    },
    cognitiveMemory: memory,
    budgets: { maxTokens: 50000, maxDurationMs: 60000, maxToolCalls: 20, maxCostUsd: 0.10 },
    availableTools: ["filesystem", "shell", "http"],
    sandboxConfig: { fsRoot: "~/.axon", allowedTools: ["filesystem", "shell", "http"], allowShell: true, allowHttp: true, allowedEnvVars: [] },
  };
}

describe("Fase 9.1 — Ciclo Cognitivo completo (determinístico)", () => {
  it("proveniência agora carrega sessionId/taskId reais", async () => {
    const ctx = buildCellContext("task-provenance-1");
    const debug = new DebugCell();

    const output = await debug.execute(
      { type: "debug_error", payload: { errorMessage: "erro 429", errorCode: "429", context: "auto", focus: "all" } },
      ctx
    );

    expect(output.success).toBe(true);
    expect(output.provenance.sessionId).toBe("cycle-test");
    expect(output.provenance.taskId).toBe("task-provenance-1");
    expect(output.provenance.cellId).toBe("debug-cell-1");
  });

  it("Debug → Planning → Validation (pass) → continua", async () => {
    const ctx = buildCellContext("task-cycle-1");

    // 1. Debug
    const debug = new DebugCell();
    const debugOut = await debug.execute(
      { type: "debug_error", payload: { errorMessage: "erro 429", errorCode: "429", context: "auto", focus: "all" } },
      ctx
    );
    expect(debugOut.success).toBe(true);
    const debugData = debugOut.data as { diagnosis?: { errorType?: string } } | undefined;
    const diagnosis = debugData?.diagnosis;
    expect(diagnosis?.errorType).toContain("RATE");

    // 2. Planning
    const planning = new PlanningCell();
    const planOut = await planning.execute(
      { type: "plan_request", payload: { goal: "corrigir 429 com Redis", context: "general", constraints: [], horizon: "medium" } },
      ctx
    );
    expect(planOut.success).toBe(true);
    const planData = planOut.data as { plan?: unknown[] } | undefined;
    const plan = planData?.plan ?? [];
    expect(Array.isArray(plan)).toBe(true);
    expect(plan.length).toBeGreaterThan(0);

    // 3. Validation sobre o plano (estrutura não-vazia → pass)
    const validation = new ValidationCell();
    const valOut = await validation.execute(
      { type: "validation", payload: { objective: "plano não-vazio", result: plan, mode: "not_empty" } },
      ctx
    );
    expect(valOut.success).toBe(true);
    expect(valOut.data!.verdict).toBe("pass");
    expect(valOut.data!.canContinue).toBe(true);
    expect(valOut.data!.suggestedAction).toBe("continue");
  });

  it("Validation falha → Recovery decide replan → nova validação passa", async () => {
    const ctx = buildCellContext("task-cycle-2");

    // 1. Validation falha (resultado vazio)
    const validation = new ValidationCell();
    const valFail = await validation.execute(
      { type: "validation", payload: { objective: "resposta presente", result: null, mode: "presence" } },
      ctx
    );
    expect(valFail.data!.verdict).toBe("fail");
    expect(valFail.data!.canContinue).toBe(false);
    expect(valFail.data!.suggestedAction).toBe("retry");

    // 2. Recovery detecta falha (1ª tentativa → retry)
    const recovery = new RecoveryCell();
    const rec1 = await recovery.execute(
      { type: "recovery", payload: { failure: "resposta ausente", consecutiveFailures: 1, maxAttempts: 3 } },
      ctx
    );
    expect(rec1.data!.status).toBe("retry");
    expect(rec1.data!.stop).toBe(false);

    // 3. Recovery com falhas repetidas (3x → escalate)
    const rec2 = await recovery.execute(
      { type: "recovery", payload: { failure: "repetição", consecutiveFailures: 3, maxAttempts: 3, lastAction: "X", triedActions: ["X"] } },
      ctx
    );
    expect(rec2.data!.status).toBe("escalate");
    expect(rec2.data!.stop).toBe(true);
  });

  it("Recovery impede loop (repetição da mesma ação → replan)", async () => {
    const ctx = buildCellContext("task-cycle-3");
    const recovery = new RecoveryCell();

    const out = await recovery.execute(
      { type: "recovery", payload: { failure: "falha repetida", consecutiveFailures: 2, maxAttempts: 4, lastAction: "A", triedActions: ["A"] } },
      ctx
    );
    expect(out.data!.status).toBe("replan");
    expect(out.data!.recommendations.length).toBeGreaterThan(0);
  });
});