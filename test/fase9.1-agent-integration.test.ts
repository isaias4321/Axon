import { describe, it, expect } from "vitest";
import {
  routeWithCognitiveSystem,
  createCognitiveMemory,
} from "../src/cognitive/index.js";
import type { CellOutput } from "../src/cognitive/index.js";
import { analyzeTask } from "../src/adaptive/taskAnalyzer.js";

/**
 * Tipos "data" das células usados apenas para leitura tipada das saídas reais.
 * Não substituem execução — apenas ajudam a inspecionar o que as células
 * realmente produziram.
 */
interface DebugOutputData {
  errorAnalyzed: string;
  diagnosis: {
    rootCause: string;
    affectedComponents: string[];
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

interface PlanningOutputData {
  goal: string;
  plan: Array<{ id: string; title: string; [k: string]: unknown }>;
  timeline: unknown[];
  successCriteria: string[];
  [k: string]: unknown;
}

function dataOf<T>(output: CellOutput | undefined): T | undefined {
  return (output?.data as T | undefined);
}

describe("Fase 9.1 — Integração Agent → CognitiveRouter → Cells", () => {
  it("DebugCell detecta erro 429 e retorna diagnóstico estruturado real", async () => {
    const task = "Investigue o erro 429 no rate limiter e planeje a correção com Redis distribuído.";
    const memory = createCognitiveMemory({ sessionPrefix: "cognitive:agent-integration" });

    const result = await routeWithCognitiveSystem(task, analyzeTask(task), "ses-1", {
      cognitiveMemory: memory,
      forceRouter: true,
    });

    // O router realmente foi acionado (sem mock de fluxo).
    expect(result.routerUsed).toBe(true);
    expect(result.classification?.primaryCellType).toBe("debug");
    expect(result.classification!.confidence).toBeGreaterThan(0.5);
    expect(result.classification!.secondaryCellTypes).toContain("planning");

    // A DebugCell REAL produziu um diagnóstico sobre o 429.
    const debugOut = result.cellResults.get("debug-cell-1");
    expect(debugOut?.success).toBe(true);
    const diag = dataOf<DebugOutputData>(debugOut);
    expect(diag?.errorAnalyzed).toContain("429");
    expect(diag?.diagnosis?.rootCause).toBeTruthy();
    expect(Array.isArray(diag?.diagnosis?.affectedComponents)).toBe(true);
  });

  it("PlanningCell produz plano real para correção com Redis distribuído", async () => {
    const task = "planejar correção do rate limiter configurando Redis distribuído";
    const result = await routeWithCognitiveSystem(task, analyzeTask(task), "ses-2", {
      cognitiveMemory: createCognitiveMemory({ sessionPrefix: "cognitive:agent-integration" }),
      forceRouter: true,
    });

    expect(result.routerUsed).toBe(true);
    expect(result.classification?.primaryCellType).toBe("planning");

    const planOut = result.cellResults.get("planning-cell-1");
    expect(planOut?.success).toBe(true);
    const plan = dataOf<PlanningOutputData>(planOut);
    expect(plan?.goal.toLowerCase()).toContain("redis");
    expect(plan?.plan.length).toBeGreaterThan(0);
    expect(plan?.successCriteria.length).toBeGreaterThan(0);
  });

  it("rota multi-célula executa Debug+Planning reais e transporta a classificação pela memória compartilhada", async () => {
    const task = "investigue o erro 429 no rate limiter e planeje a correção com Redis distribuído";
    const sessionId = "ses-3";
    const memory = createCognitiveMemory({ sessionPrefix: "cognitive" });

    const result = await routeWithCognitiveSystem(task, analyzeTask(task), sessionId, {
      cognitiveMemory: memory,
      forceRouter: true,
    });

    // Execução real multi-célula (sem mock).
    expect(result.routerUsed).toBe(true);
    expect(result.allSuccessful).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.cellResults.has("debug-cell-1")).toBe(true);
    expect(result.cellResults.has("planning-cell-1")).toBe(true);

    // O router DEVE ter usado a MESMA memória compartilhada que as células,
    // gravando a classificação (`intent:<taskId>`) ali — o CognitiveContext
    // compartilhado é o que conecta router, cells e agent nesta execução.
    const entry = await memory.get(`cognitive:${sessionId}:intent:${result.taskId}`);
    expect(entry?.value).toBeTruthy();
    expect(entry?.value?.primaryCellType).toBe("debug");
  });
});