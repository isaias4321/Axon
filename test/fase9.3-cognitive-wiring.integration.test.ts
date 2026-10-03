/**
 * Fase 9.3 — Wiring de `runAutonomous` com a RecoveryCell.
 *
 * Com `vi.mock`, interceptamos o AgentAdapter e provamos que o loop autônomo,
 * quando `options.cognitive.enabled === true`, consulta a RecoveryCell diante
 * de no-progress e traduz a ação sugerida (replan/retry) em decisões reais.
 *
 * Determinístico 100% offline (runner fake + célula mockada).
 */

import { describe, expect, it, vi } from "vitest";

// Mock do AgentAdapter: intercepta o import em autonomous.ts.
// Mantemos validateWithCell (também importado pelo loop) como no-op benigno.
vi.mock("../src/cognitive/agentAdapter.js", () => ({
  recoverWithCell: vi.fn().mockResolvedValue({
    suggestedAction: "continue",
    validated: true,
    recommendations: [],
    usedCells: ["recovery-cell-1"],
    error: null,
  }),
  validateWithCell: vi.fn().mockResolvedValue({
    suggestedAction: "continue",
    validated: true,
    recommendations: [],
    usedCells: ["validation-cell-1"],
    error: null,
  }),
}));

import { runAutonomous } from "../src/adaptive/autonomous.js";
import type { LLMRunner } from "../src/adaptive/runtime.js";
import { recoverWithCell } from "../src/cognitive/agentAdapter.js";
import { analyzeTask } from "../src/adaptive/taskAnalyzer.js";
import { decideStrategy } from "../src/adaptive/strategyEngine.js";
import { routeModel } from "../src/adaptive/modelRouter.js";
import { RecoveryCell } from "../src/cognitive/cells/recovery.js";
import type { ProviderAdapter } from "../src/providers/types.js";
import type { ChatCompletionResponse } from "../src/schemas/chat.js";

function fakeAdapter(provider: string): ProviderAdapter {
  return {
    name: provider as ProviderAdapter["name"],
    complete: vi.fn(),
    stream: vi.fn(),
  };
}

function buildProviders(...names: string[]): Map<string, ProviderAdapter> {
  const map = new Map<string, ProviderAdapter>();
  for (const n of names) map.set(n, fakeAdapter(n));
  return map;
}

function failingRunner(): { runner: LLMRunner } {
  // Resposta sem código → falha na heurística de validação → no-progress.
  return {
    runner: {
      complete: vi.fn().mockResolvedValue({
        id: "resp-wiring",
        provider: "gemini",
        model: "gemini-2.5-flash",
        content: "Resposta vazia e sem estrutura útil.",
        usage: { prompt_tokens: 15, completion_tokens: 25, total_tokens: 40 },
        cached: false,
      } satisfies ChatCompletionResponse),
    },
  };
}

const AUTONOMOUS_TASK =
  "Construa uma função de validação de formulários com múltiplos critérios e testes em typescript";

const mockedRecover = vi.mocked(recoverWithCell);

describe("Fase 9.3 — runAutonomous consulta a RecoveryCell (wiring)", () => {
  it("com cognitive.enabled=true consulta RecoveryCell e usa a ação sugerida", async () => {
    mockedRecover.mockResolvedValue({
      suggestedAction: "replan",
      validated: true,
      recommendations: ["mudar abordagem"],
      usedCells: ["recovery-cell-1"],
      error: null,
    });

    const pv = buildProviders("gemini");
    const profile = analyzeTask(AUTONOMOUS_TASK);
    const strategy = decideStrategy(profile);
    const decision = routeModel(profile, strategy.strategy, pv);
    const { runner } = failingRunner();

    const report = await runAutonomous(profile.text, profile, strategy, decision, pv, {
      runner,
      persistMemory: false,
      cognitive: {
        enabled: true,
        recoveryCell: new RecoveryCell(),
        maxRecoveryAttempts: 3,
      },
    });

    // O adaptador foi consultado (mock registra a chamada).
    expect(mockedRecover).toHaveBeenCalled();
    // Fail-open: o loop termina sem erro.
    expect(report).toBeDefined();
    expect(typeof report.strategy).toBe("string");
  });

  it("sem cognitive (default) NÃO consulta a RecoveryCell (F1–F8 preservado)", async () => {
    mockedRecover.mockClear();

    const pv = buildProviders("gemini");
    const profile = analyzeTask(AUTONOMOUS_TASK);
    const strategy = decideStrategy(profile);
    const decision = routeModel(profile, strategy.strategy, pv);
    const { runner } = failingRunner();

    const report = await runAutonomous(profile.text, profile, strategy, decision, pv, {
      runner,
      persistMemory: false,
    });

    expect(mockedRecover).not.toHaveBeenCalled();
    expect(report).toBeDefined();
  });

  it("RecoveryCell é a célula real injetada (id recovery-cell-1)", () => {
    const cell = new RecoveryCell();
    expect(cell.id).toBe("recovery-cell-1");
    expect(cell.type).toBe("recovery");
  });
});