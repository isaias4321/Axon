/**
 * Fase 9.2 — Comunicação real entre Cognitive Cells.
 *
 * Prova que o CellSupervisor executa células de verdade e faz cumprir:
 *   - detecção de ciclo (A→B→A);
 *   - profundidade máxima;
 *   - orçamento de chamadas;
 *   - timeout;
 *   - proveniência com linhagem (parentCellId/parentCellType/depth).
 */

import { describe, expect, it } from "vitest";

import { DefaultCellSupervisor } from "../src/cognitive/supervisor.js";
import { CellDelegationError } from "../src/cognitive/types.js";
import type {
  CellExecutionContext,
  CellInput,
  CellType,
  CognitiveCell,
} from "../src/cognitive/types.js";
import { BaseCognitiveCell } from "../src/cognitive/cell.js";

// ── Células stub determinísticas para exercitar as guardas ──────────

function makeStubCell(
  id: string,
  type: CellType,
  behavior: (ctx: CellExecutionContext) => Promise<Record<string, unknown>> = async () => ({ ok: true })
): CognitiveCell {
  class Stub extends BaseCognitiveCell<CellInput, Record<string, unknown>> {
    public readonly id = id;
    public readonly type = type;
    public readonly name = id;
    public readonly capabilities = type === "research"
      ? ["code_search" as const]
      : ["root_cause_analysis" as const];
    public readonly description = "stub";
    protected inputMatchesCapability(): boolean {
      return true; // stub aceita qualquer input
    }
    protected async executeImpl(
      _input: CellInput,
      ctx: CellExecutionContext
    ): Promise<Record<string, unknown>> {
      return behavior(ctx);
    }
  }
  return new Stub();
}

function baseContext(overrides: Partial<CellExecutionContext> = {}): CellExecutionContext {
  return {
    sessionId: "s-f92",
    taskId: "t-f92",
    taskProfile: {
      capabilities: ["raciocinio"],
      category: "geral",
      complexity: "media",
      text: "",
      hints: [],
      wordCount: 0,
      charCount: 0,
    },
    cognitiveMemory: {
      set: () => Promise.resolve(),
      get: () => Promise.resolve(undefined),
      delete: () => Promise.resolve(),
      list: () => Promise.resolve([]),
      clear: () => Promise.resolve(),
    },
    budgets: { maxTokens: 50000, maxDurationMs: 60000, maxToolCalls: 20, maxCostUsd: 0.1 },
    availableTools: [],
    sandboxConfig: {
      fsRoot: "./",
      allowedTools: [],
      allowShell: false,
      allowHttp: false,
      allowedEnvVars: [],
    },
    delegationChain: [],
    ...overrides,
  };
}

describe("Fase 9.2 — DefaultCellSupervisor (delegação real)", () => {
  it("requestCell executa a célula alvo de verdade", async () => {
    let executed = false;
    const research = makeStubCell("research-cell-1", "research", async () => {
      executed = true;
      return { findings: [{ path: "src/x.ts" }] };
    });
    const supervisor = new DefaultCellSupervisor(
      (t) => (t === "research" ? research : undefined),
      (_t, req) => ({ type: "research_query", payload: { query: String(req) } })
    );

    const out = await supervisor.requestCell({
      cellType: "research",
      request: "localize a origem do erro",
      context: baseContext(),
      parentCellId: "debug-cell-1",
    });

    expect(executed).toBe(true);
    expect(out.success).toBe(true);
  });

  it("proveniência carrega linhagem (parentCellId + parentCellType + depth)", async () => {
    const research = makeStubCell("research-cell-1", "research");
    const supervisor = new DefaultCellSupervisor(
      (t) => (t === "research" ? research : undefined),
      (_t, req) => ({ type: "research_query", payload: { query: String(req) } })
    );

    const parentCtx = baseContext({
      delegationChain: ["debug"],
      parentCell: { id: "debug-cell-1", type: "debug", depth: 1 },
    });
    const out = await supervisor.requestCell({
      cellType: "research",
      request: "q",
      context: parentCtx,
      parentCellId: "debug-cell-1",
    });

    expect(out.provenance?.parentCellId).toBe("debug-cell-1");
    expect(out.provenance?.parentCellType).toBe("debug");
    expect(out.provenance?.depth).toBe(2);
  });

  it("detecta ciclo A→B→A (CYCLE_DETECTED)", async () => {
    const registry = new Map<CellType, CognitiveCell>([
      ["debug", makeStubCell("a-cell", "debug")],
      ["research", makeStubCell("r-cell", "research")],
    ]);
    const supervisor = new DefaultCellSupervisor(
      (t) => registry.get(t),
      (_t, req) => ({ type: "research_query", payload: { query: String(req) } }),
      { maxDepth: 5, maxCellCalls: 10 }
    );

    // Cadeia [debug → research] tentando delegar para research de novo
    const err = await supervisor.requestCell({
      cellType: "research",
      request: "volta pro inicio",
      context: baseContext({ delegationChain: ["debug", "research"] }),
      parentCellId: "r-cell",
    }).then(() => null, (e: unknown) => e);

    expect(err).toBeInstanceOf(CellDelegationError);
    expect((err as CellDelegationError).reason).toBe("CYCLE_DETECTED");
    expect(supervisor.getTraces().some((t) => t.outcome === "cycle_detected")).toBe(true);
  });

  it("ciclo A→B→C→A também é detectado via delegationChain", async () => {
    const validation = makeStubCell("v", "validation");
    const supervisor = new DefaultCellSupervisor(
      (t) => (t === "validation" ? validation : undefined),
      () => ({ type: "validation", payload: { objective: "" } })
    );

    const err = await supervisor.requestCell({
      cellType: "validation",
      request: "x",
      context: baseContext({ delegationChain: ["debug", "planning", "validation"] }),
      parentCellId: "p",
    }).then(() => null, (e: unknown) => e);

    expect(err).toBeInstanceOf(CellDelegationError);
    expect((err as CellDelegationError).reason).toBe("CYCLE_DETECTED");
  });
});


describe("Fase 9.2 — guardas de budget/timeout/registro", () => {
  it("DEPTH_EXCEEDED quando depth > maxDepth", async () => {
    const research = makeStubCell("r", "research");
    const supervisor = new DefaultCellSupervisor(
      (t) => (t === "research" ? research : undefined),
      (_t, req) => ({ type: "research_query", payload: { query: String(req) } }),
      { maxDepth: 2 }
    );

    // Cadeia de tamanho 2 SEM 'research' → depth da nova chamada seria 3 > 2
    const err = await supervisor.requestCell({
      cellType: "research",
      request: "x",
      context: baseContext({ delegationChain: ["debug", "planning"] }),
      parentCellId: "p",
    }).then(() => null, (e: unknown) => e);

    expect(err).toBeInstanceOf(CellDelegationError);
    expect((err as CellDelegationError).reason).toBe("DEPTH_EXCEEDED");
  });

  it("BUDGET_EXCEEDED ao esgotar maxCellCalls", async () => {
    const research = makeStubCell("r", "research");
    const supervisor = new DefaultCellSupervisor(
      (t) => (t === "research" ? research : undefined),
      (_t, req) => ({ type: "research_query", payload: { query: String(req) } }),
      { maxCellCalls: 2 }
    );
    const call = () =>
      supervisor.requestCell({
        cellType: "research",
        request: "x",
        context: baseContext(),
        parentCellId: "dbg",
      });

    await call();
    await call();
    const err = await call().then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(CellDelegationError);
    expect((err as CellDelegationError).reason).toBe("BUDGET_EXCEEDED");
  });

  it("TIMEOUT quando a célula excede timeoutMs", async () => {
    const slow = makeStubCell("slow", "research", async () => {
      await new Promise((r) => setTimeout(r, 200));
      return {};
    });
    const supervisor = new DefaultCellSupervisor(
      (t) => (t === "research" ? slow : undefined),
      (_t, req) => ({ type: "research_query", payload: { query: String(req) } }),
      { timeoutMs: 30 }
    );

    const err = await supervisor.requestCell({
      cellType: "research",
      request: "x",
      context: baseContext(),
      parentCellId: "dbg",
    }).then(() => null, (e: unknown) => e);

    expect(err).toBeInstanceOf(CellDelegationError);
    expect((err as CellDelegationError).reason).toBe("TIMEOUT");
  });

  it("CELL_NOT_FOUND para tipo não registrado", async () => {
    const supervisor = new DefaultCellSupervisor(
      () => undefined,
      () => ({ type: "research_query", payload: { query: "" } })
    );
    const err = await supervisor.requestCell({
      cellType: "code_review",
      request: "x",
      context: baseContext(),
      parentCellId: "dbg",
    }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(CellDelegationError);
    expect((err as CellDelegationError).reason).toBe("CELL_NOT_FOUND");
  });

  it("traces auditam as tentativas bem-sucedidas", async () => {
    const research = makeStubCell("r", "research");
    const supervisor = new DefaultCellSupervisor(
      (t) => (t === "research" ? research : undefined),
      (_t, req) => ({ type: "research_query", payload: { query: String(req) } })
    );
    await supervisor.requestCell({
      cellType: "research",
      request: "x",
      context: baseContext(),
      parentCellId: "dbg",
    });

    expect(supervisor.getTraces().map((t) => t.outcome)).toContain("ok");
  });
});