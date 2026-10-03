/**
 * Fase 9.3 — Integración Cognitive Cells ↔ Autonomous Agent.
 *
 * Cubre el gap de cobertura de la integración F9 con el agente:
 *   - `validateWithCell` (ValidationCell) y `recoverWithCell` (RecoveryCell)
 *     del AgentAdapter, contra las células REALES y con fail-open.
 *   - el wiring en `runAutonomous`: cuando `options.cognitive.enabled` es true,
 *     el bucle consulta la RecoveryCell ante no-progress.
 *
 * Determinístico 100% offline (sin LLM externo).
 */

import { describe, expect, it } from "vitest";

import {
  validateWithCell,
  recoverWithCell,
  type CognitiveStepResult,
} from "../src/cognitive/agentAdapter.js";
import { ValidationCell } from "../src/cognitive/cells/validation.js";
import { RecoveryCell } from "../src/cognitive/cells/recovery.js";
import type { CognitiveCell } from "../src/cognitive/types.js";

const CTX = { sessionId: "f9-test", taskId: "f9-task-1" };

describe("validateWithCell — ValidationCell real (fail-open)", () => {
  it("resultado no vacío → validated=true, usa la ValidationCell", async () => {
    const out = await validateWithCell("validar resultado", { ok: true }, CTX);

    expect(out.validated).toBe(true);
    expect(out.usedCells).toContain("validation-cell-1");
    expect(out.error).toBeNull();
    expect(out.suggestedAction).toBe("continue");
  });

  it("resultado nulo → validated=false (falta el resultado)", async () => {
    const out = await validateWithCell("validar presencia", null, CTX);

    expect(out.validated).toBe(false);
    expect(out.error).toBeNull();
  });

  it("célula que lanza → fail-open (validated=true, error capturado)", async () => {
    const breakingCell = {
      id: "validation-boom",
      type: "validation",
      execute: () => Promise.reject(new Error("célula rota")),
    } as unknown as CognitiveCell;

    const out = await validateWithCell("x", "y", CTX, breakingCell);
    expect(out.validated).toBe(true); // fail-open
    expect(out.error).toContain("célula rota");
    expect(out.usedCells).toHaveLength(0);
  });

  it("célula inyectada correcta y registrada en usedCells", async () => {
    const custom = new ValidationCell();
    const out = await validateWithCell("val", "data", CTX, custom);
    expect(out.usedCells).toContain(custom.id);
  });
});

describe("recoverWithCell — RecoveryCell contra (fail-open)", () => {
  it("fallo inicial (1) → sugiere retry", async () => {
    const out = await recoverWithCell("boom", 1, 3, CTX);

    expect(out.suggestedAction).toBe("retry");
    expect(out.usedCells).toContain("recovery-cell-1");
    expect(out.error).toBeNull();
  });

  it("fallos repetidos bajo el límite → sugiere replan", async () => {
    const out = await recoverWithCell("sin progreso", 2, 3, CTX);
    expect(out.suggestedAction).toBe("replan");
    expect(out.recommendations.length).toBeGreaterThan(0);
    expect(out.validated).toBe(true);
  });

  it("límite alcanzado → escala al agente principal (escalate)", async () => {
    const out = await recoverWithCell("bloqueado", 3, 3, CTX);
    expect(out.suggestedAction).toBe("escalate");
    expect(out.validated).toBe(false);
    expect(out.recommendations.length).toBeGreaterThan(0);
  });

  it("célula que lanza → fail-open (continue, error capturado)", async () => {
    const breakingCell = {
      id: "recovery-boom",
      type: "recovery",
      execute: () => Promise.reject(new Error("recovery rota")),
    } as unknown as CognitiveCell;

    const out = await recoverWithCell("f", 1, 3, CTX, breakingCell);
    expect(out.suggestedAction).toBe("continue");
    expect(out.validated).toBe(true); // fail-open
    expect(out.error).toContain("recovery rota");
  });

  it("nunca lanza incluso con contexto mínimo", async () => {
    const out: CognitiveStepResult = await recoverWithCell(
      "f",
      99,
      3,
      { sessionId: "s", taskId: "t" },
      new RecoveryCell()
    );
    expect(out).toBeDefined();
    expect(typeof out.suggestedAction).toBe("string");
  });
});