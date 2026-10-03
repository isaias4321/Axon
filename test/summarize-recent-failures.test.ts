import { describe, expect, it } from "vitest";

import { summarizeRecentFailures } from "../src/adaptive/autonomous.js";
import type { CycleLog, Observation, ValidationResult, Decision } from "../src/adaptive/types.js";

/**
 * Regressão: quando o loop autônomo falha (ex.: tentar criar um .rar sem
 * CLI de RAR disponível), `synthesizeFallbackAnswer` só recebia o texto
 * original da tarefa do usuário — o motivo real do erro (que a própria
 * tool já havia relatado com clareza) era descartado, e o LLM tinha que
 * ADIVINHAR uma resposta final sem esse contexto. `summarizeRecentFailures`
 * extrai esse contexto de `cycleLogs` para alimentar o fallback.
 */

function makeObservation(overrides: Partial<Observation>): Observation {
  return {
    success: false,
    output: null,
    error: null,
    exitCode: 1,
    durationMs: 10,
    toolName: "compression",
    metadata: {},
    ...overrides,
  };
}

const dummyValidation: ValidationResult = {
  passed: false,
  confidence: 0,
  issues: [],
  validatorType: "heuristic",
  suggestedCorrection: null,
};

const dummyDecision: Decision = {
  action: "continue",
  reason: "test",
  confidence: 0,
  metadata: {},
};

function makeLog(toolName: string, observation: Partial<Observation>, iteration: number): CycleLog {
  return {
    iteration,
    stepId: `step-${iteration}`,
    stepDescription: "teste",
    capability: "execucao_ferramenta",
    toolName,
    observation: makeObservation({ toolName, ...observation }),
    validation: dummyValidation,
    decision: dummyDecision,
    timestamp: Date.now(),
    durationMs: 10,
  };
}

describe("summarizeRecentFailures", () => {
  it("retorna null quando não há erros nos logs", () => {
    const logs = [makeLog("compression", { success: true, error: null, output: "ok" }, 1)];
    expect(summarizeRecentFailures(logs)).toBeNull();
  });

  it("retorna null para lista vazia", () => {
    expect(summarizeRecentFailures([])).toBeNull();
  });

  it("inclui o motivo real do erro da tool (ex.: RAR sem CLI disponível)", () => {
    const logs = [
      makeLog(
        "compression",
        {
          error:
            "A criação de arquivos .rar requer utilitário CLI (rar, WinRAR ou 7-Zip) instalado no ambiente do sistema. Como alternativa, utilize o formato .zip.",
        },
        1
      ),
    ];

    const summary = summarizeRecentFailures(logs);
    expect(summary).not.toBeNull();
    expect(summary).toContain("compression");
    expect(summary).toContain("CLI");
    expect(summary).toContain(".zip");
  });

  it("deduplica erros repetidos e mantém no máximo `maxDistinct` motivos distintos, mais recentes primeiro", () => {
    const logs = [
      makeLog("compression", { error: "erro A" }, 1),
      makeLog("compression", { error: "erro A" }, 2), // repetido — não deve duplicar
      makeLog("compression", { error: "erro B" }, 3),
      makeLog("filesystem", { error: "erro C" }, 4),
      makeLog("filesystem", { error: "erro D" }, 5),
    ];

    const summary = summarizeRecentFailures(logs, 2);
    expect(summary).not.toBeNull();
    const lines = summary!.split("\n");
    expect(lines).toHaveLength(2);
    // Mais recente primeiro
    expect(lines[0]).toContain("erro D");
    expect(lines[1]).toContain("erro C");
  });

  it("também captura falha reportada apenas via `output` quando `error` é null", () => {
    const logs = [
      makeLog("compression", { success: false, error: null, output: "falhou silenciosamente" }, 1),
    ];
    const summary = summarizeRecentFailures(logs);
    expect(summary).toContain("falhou silenciosamente");
  });
});
