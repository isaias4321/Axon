/**
 * Fase 9.2 — E2E Determinístico do Runtime Cognitivo
 *
 * Teste E2E real que executa o pipeline completo de integração:
 * Agent → CognitiveRouter → Cells → Agent, via `routeWithCognitiveSystem`.
 *
 * Usa classificação determinística (sem LLM externo) e ToolRegistry real.
 * As células executadas refletem exatamente o dispatch real do router para
 * cada tarefa (não são mockadas).
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  createCognitiveSystem,
  createCognitiveMemory,
  routeWithCognitiveSystem,
  type CognitiveMemory,
  type CellOutput,
} from "../src/cognitive/index.js";
import { analyzeTask, type TaskProfile } from "../src/adaptive/taskAnalyzer.js";

/** Acesso somente-leitura tipado aos dados reais produzidos pelas células. */
function dataOf<T>(output: CellOutput | undefined): T | undefined {
  return output?.data as T | undefined;
}

const COMPLEX_TASK =
  "Investigue o erro 429 do rate limiter, encontre a configuração responsável, diagnostique a causa e crie um plano de correção usando Redis distribuído.";

describe("Fase 9.2 — E2E Runtime Cognitive Pipeline", () => {
  let memory: ReturnType<typeof createCognitiveMemory>;
  let system: ReturnType<typeof createCognitiveSystem>;

  beforeEach(() => {
    system = createCognitiveSystem();
    // Memória compartilhada com prefixo de sessão conhecido — a MESMA instância
    // que é passada ao roteador na asserção de contexto compartilhado.
    memory = createCognitiveMemory({ sessionPrefix: "cognitive" });
  });

  it("Agent → Router → DebugCell → PlanningCell → ConfigCell → Agent (fluxo completo)", async () => {
    const routeProfile: TaskProfile = {
      ...analyzeTask(COMPLEX_TASK),
      text: COMPLEX_TASK,
    };

    const result = await routeWithCognitiveSystem(COMPLEX_TASK, routeProfile, "e2e-fluxo-1", {
      cognitiveMemory: memory,
      forceRouter: true,
    });

    // 1. Router usado de fato.
    expect(result.routerUsed).toBe(true);

    // 2. Classificação real: debug primário + planejamento/configuração secundários.
    expect(result.classification?.primaryCellType).toBe("debug");
    expect(result.classification?.secondaryCellTypes).toContain("planning");
    expect(result.classification!.confidence).toBeGreaterThan(0.5);

    // 3. Pipeline real multi-célula: Debug + Planning + Config, sem erros.
    expect(result.allSuccessful).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.cellResults.has("debug-cell-1")).toBe(true);
    expect(result.cellResults.has("planning-cell-1")).toBe(true);
    expect(result.cellResults.has("config-cell-1")).toBe(true);

    // 4. DebugCell produziu um diagnóstico estruturado real.
    const debugOut = result.cellResults.get("debug-cell-1");
    expect(debugOut?.success).toBe(true);
    const debugData = dataOf<{ diagnosis?: { errorType?: string } }>(debugOut);
    expect(debugData?.diagnosis?.errorType).toContain("RATE");

    // 5. PlanningCell produziu um plano real.
    const planOut = result.cellResults.get("planning-cell-1");
    expect(planOut?.success).toBe(true);
    const planData = dataOf<{ plan?: unknown[] }>(planOut);
    expect(Array.isArray(planData?.plan)).toBe(true);
    expect(planData!.plan!.length).toBeGreaterThan(0);

    // 6. ConfigCell produziu um resultado real.
    const configOut = result.cellResults.get("config-cell-1");
    expect(configOut?.success).toBe(true);

    // 7. O router gravou a classificação na MESMA memória compartilhada usada
    //    pelas células (prefixo de sessão + intent:<taskId>).
    const intentEntry = await memory.get(`cognitive:e2e-fluxo-1:intent:${result.taskId}`);
    expect(intentEntry).toBeDefined();
    expect(intentEntry?.value?.primaryCellType).toBe("debug");
    expect(intentEntry?.value?.secondaryCellTypes).toContain("planning");
  });

  it("sem capacidade especializada → delega ao agente padrão (routerUsed false)", async () => {
    const result = await routeWithCognitiveSystem(
      "olá, tudo bem?",
      analyzeTask("olá, tudo bem?"),
      "fallback-test",
      { forceRouter: false }
    );

    expect(result.routerUsed).toBe(false);
    expect(result.allSuccessful).toBe(true);
    expect(result.cellResults.size).toBe(0);
  });

  it("tarefa só de configuração → apenas a ConfigCell executa", async () => {
    const task = "ver configuração do rate limiter";
    const result = await routeWithCognitiveSystem(task, analyzeTask(task), "config-only", {
      cognitiveMemory: createCognitiveMemory({ sessionPrefix: "cognitive" }),
      forceRouter: true,
    });

    expect(result.routerUsed).toBe(true);
    expect(result.allSuccessful).toBe(true);
    expect(result.errors).toEqual([]);

    // Nenhuma célula de debug/planejamento foi acionada para esta tarefa.
    expect(result.cellResults.has("config-cell-1")).toBe(true);
    expect(
      Array.from(result.cellResults.values()).every((o) => o.provenance?.cellType === "config")
    ).toBe(true);
  });
});