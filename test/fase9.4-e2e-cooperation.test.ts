/**
 * Fase 9.2 — E2E determinístico de COOPERAÇÃO real entre células.
 *
 * Fluxo provado (sem LLM, sem rede):
 *   Agent → Router → DebugCell
 *                  → requestCell(research) → ResearchCell → ToolRegistry.grep REAL
 *                  → findings voltam para DebugCell
 *   Agent → PlanningCell (consome o diagnóstico REAL do debug)
 *         → ValidationCell (valida o plano)
 *         → RecoveryCell (se validação falhar)
 */

import { describe, expect, it } from "vitest";
import { resolve } from "node:path";

import {
  createDefaultCognitiveCells,
  createCognitiveMemory,
} from "../src/cognitive/index.js";
import { CognitiveRouter } from "../src/cognitive/router.js";
import type { RoutingContext } from "../src/cognitive/router.js";
import { PlanningCell } from "../src/cognitive/cells/planning.js";
import { ValidationCell } from "../src/cognitive/cells/validation.js";
import type { CellOutput } from "../src/cognitive/types.js";

const TASK =
  "Investigue o erro 429 do rate limiter do gateway, localize sua origem no código e produza um plano de correção.";

function buildContext(
  memory: ReturnType<typeof createCognitiveMemory>,
  taskId: string
): RoutingContext {
  return {
    sessionId: "coop-f92",
    taskId,
    taskProfile: {
      capabilities: ["raciocinio"],
      category: "geral",
      complexity: "media",
    },
    cognitiveMemory: memory,
    budgets: { maxTokens: 50000, maxDurationMs: 60000, maxToolCalls: 20, maxCostUsd: 0.1 },
    sandboxConfig: {
      fsRoot: resolve("./src"),
      allowedTools: ["filesystem", "shell", "http", "grep"],
      allowShell: true,
      allowHttp: true,
      allowedEnvVars: [],
    },
    availableTools: ["filesystem", "shell", "http", "grep"],
  };
}

function buildRouter(memory: ReturnType<typeof createCognitiveMemory>): CognitiveRouter {
  return new CognitiveRouter({
    cells: createDefaultCognitiveCells(),
    cognitiveMemory: memory,
    defaultBudgets: { maxTokens: 50000, maxDurationMs: 60000, maxToolCalls: 20, maxCostUsd: 0.1 },
    defaultSandbox: {
      fsRoot: resolve("./src"),
      allowedTools: ["filesystem", "shell", "http", "grep"],
      allowShell: true,
      allowHttp: true,
      allowedEnvVars: [],
    },
    enableParallelDispatch: true,
    interCellTimeoutMs: 15000,
    maxParallelCells: 3,
  });
}

describe("Fase 9.2 — E2E cooperação Debug→Research→Planning→Validation", () => {
  it("DebugCell delega à ResearchCell que executa grep REAL e retorna findings", async () => {
    const memory = createCognitiveMemory({ sessionPrefix: "cognitive" });
    const router = buildRouter(memory);
    const result = await router.route(TASK, buildContext(memory, "coop:t1"));

    // 1. Router despachou a primária (debug)
    expect(result.results.has("debug-cell-1")).toBe(true);
    expect(result.allSuccessful).toBe(true);

    // 2. DELEGAÇÃO REAL: a DebugCell emite mensagem pós-execução da ResearchCell
    const bus = router.getMessages();
    const researchMsg = bus.find((m) => JSON.stringify(m.payload).includes("ResearchCell"));
    expect(researchMsg).toBeDefined();

    // 3. O diagnóstico usa a evidência trazida pela delegação (não descartada)
    const debugOut = result.results.get("debug-cell-1")!;
    expect(debugOut.success).toBe(true);
    const diagnosis = (debugOut.data as {
      diagnosis?: { evidence?: Array<{ description?: string }> };
    }).diagnosis;
    const viaResearch = (diagnosis?.evidence ?? []).filter((e) =>
      e.description?.includes("[via ResearchCell]")
    );
    expect(viaResearch.length).toBeGreaterThan(0);
  });

  it("PlanningCell consome o diagnóstico real do debug; ValidationCell aprova o plano", async () => {
    const memory = createCognitiveMemory({ sessionPrefix: "cognitive" });
    const router = buildRouter(memory);

    // Etapa 1 — debug + pesquisa delegada
    const routed = await router.route(TASK, buildContext(memory, "coop:t2"));
    const debugOut = routed.results.get("debug-cell-1")!;
    const debugData = debugOut.data as {
      diagnosis?: { rootCause?: string; suggestedFixes?: Array<{ description?: string }> };
    };

    // Etapa 2 — PlanningCell recebe o diagnóstico REAL (sem hardcode)
    const planning = new PlanningCell();
    const goal = `corrigir ${debugData.diagnosis?.rootCause ?? "erro"} — ${
      debugData.diagnosis?.suggestedFixes?.[0]?.description ?? ""
    }`;
    const planOut: CellOutput = await planning.execute(
      { type: "plan_request", payload: { goal, context: "general", constraints: [], horizon: "medium" } },
      buildContext(memory, "coop:t2")
    );
    expect(planOut.success).toBe(true);
    const planData = planOut.data as { plan?: unknown[]; successCriteria?: string[] };
    expect(Array.isArray(planData.plan)).toBe(true);
    expect(planData.plan!.length).toBeGreaterThan(0);

    // Etapa 3 — ValidationCell valida o plano produzido
    const validation = new ValidationCell();
    const valOut = await validation.execute(
      {
        type: "validation",
        payload: { objective: "plano de correção do 429", result: planData.plan, mode: "not_empty" },
      },
      buildContext(memory, "coop:t2")
    );
    expect(valOut.success).toBe(true);
    expect(valOut.data!.verdict).toBe("pass");
    expect(valOut.data!.canContinue).toBe(true);
  });

  it("Validation FAIL em plano vazio → Recovery sugere replan/retry (ciclo de recuperação)", async () => {
    const validation = new ValidationCell();
    const valFail = await validation.execute(
      { type: "validation", payload: { objective: "plano", result: [], mode: "not_empty" } },
      buildContext(createCognitiveMemory({}), "coop:t3")
    );
    expect(valFail.data!.verdict).toBe("fail");

    const recovery = await import("../src/cognitive/agentAdapter.js");
    const rec = await recovery.recoverWithCell(
      valFail.data!.summary || "validacao falhou",
      2,
      3,
      { sessionId: "coop-f92", taskId: "coop:t3" }
    );
    expect(["replan", "retry"]).toContain(rec.suggestedAction);
  });
});
