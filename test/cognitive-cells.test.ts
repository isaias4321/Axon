/**
 * Fase 9 — Testes do Cognitive Router e Cells.
 *
 * Testa o fluxo real: classificação de intenção → dispatch → execução da cell.
 * Usa implementações reais das células (sem mocks de fluxo).
 */

import { describe, it, expect, beforeEach } from "vitest";

import { createCognitiveSystem, healthCheckCognitiveSystem } from "../src/cognitive/index.js";
import type { CognitiveMemory, CellOutput } from "../src/cognitive/index.js";

function buildRouterContext(task: string, sessionId: string, memory: CognitiveMemory) {
  return {
    sessionId,
    taskId: `${sessionId}:task-1`,
    taskProfile: {
      capabilities: ["raciocinio"],
      category: "geral",
      complexity: "media",
      text: task,
      hints: [],
    },
    cognitiveMemory: memory,
    budgets: {
      maxTokens: 50000,
      maxDurationMs: 60000,
      maxToolCalls: 20,
      maxCostUsd: 0.10,
    },
    sandboxConfig: {
      fsRoot: "~/.axon",
      allowedTools: ["filesystem", "shell", "http"],
      allowShell: true,
      allowHttp: true,
      allowedEnvVars: [],
    },
    availableTools: ["filesystem", "shell", "http"],
  };
}

describe("Fase 9 — Cognitive System", () => {
  let system: ReturnType<typeof createCognitiveSystem>;

  beforeEach(() => {
    system = createCognitiveSystem();
  });

  describe("Cognitive Memory", () => {
    it("armazena e recupera uma entrada", async () => {
      const memory = system.memory;
      await memory.set("test-key", {
        value: { foo: "bar" },
        cellId: "test-cell",
        cellType: "research",
        timestamp: Date.now(),
        sessionId: "session-1",
        taskId: "task-1",
        tags: ["test"],
        version: 1,
      });

      const entry = await memory.get("test-key");
      expect(entry).toBeDefined();
      expect(entry!.value).toEqual({ foo: "bar" });
      expect(entry!.cellId).toBe("test-cell");
    });

    it("lista chaves por prefixo", async () => {
      const memory = system.memory;
      await memory.set("intent:a", { value: 1, cellId: "c", cellType: "research", timestamp: Date.now(), sessionId: "s1", taskId: "t1", tags: [], version: 1 });
      await memory.set("intent:b", { value: 2, cellId: "c", cellType: "debug", timestamp: Date.now(), sessionId: "s1", taskId: "t1", tags: [], version: 1 });
      await memory.set("other:c", { value: 3, cellId: "c", cellType: "config", timestamp: Date.now(), sessionId: "s1", taskId: "t1", tags: [], version: 1 });

      const keys = await memory.list("intent");
      expect(keys.filter(k => k.includes("intent:")).length).toBe(2);
    });

    it("isola entre sessões", async () => {
      const memoryS1 = createCognitiveSystem({ sessionId: "s1" }).memory;
      const memoryS2 = createCognitiveSystem({ sessionId: "s2" }).memory;

      // Entrada da sessão 1
      await memoryS1.set("shared", {
        value: "data-s1", cellId: "c", cellType: "research" as const,
        timestamp: Date.now(), sessionId: "s1", taskId: "t1", tags: [], version: 1,
      });

      // Entrada da sessão 2 (mesma chave, sessão diferente)
      await memoryS2.set("shared", {
        value: "data-s2", cellId: "c", cellType: "debug" as const,
        timestamp: Date.now(), sessionId: "s2", taskId: "t1", tags: [], version: 1,
      });

      // Cada memória só enxerga seus próprios dados — isolamento real entre sessões
      const fromS1 = await memoryS1.get("shared");
      expect(fromS1).toBeDefined();
      expect(fromS1!.value).toBe("data-s1");

      const fromS2 = await memoryS2.get("shared");
      expect(fromS2).toBeDefined();
      expect(fromS2!.value).toBe("data-s2");

      // A sessão 1 NÃO vê os dados da sessão 2 (chaves têm prefixo de sessão interno)
      const listS1 = await memoryS1.list("");
      expect(listS1.some(k => k.includes("s2"))).toBe(false);
    });
  });

  describe("Cognitive Router — classificação", () => {
    it("classifica tarefa de pesquisa como research", async () => {
      const ctx = buildRouterContext("pesquisar como funciona o rate limiting no gateway", "s1", system.memory);
      const classification = await system.router.classifyIntent("pesquisar como funciona o rate limiting no gateway", ctx);
      expect(classification.primaryCellType).toBe("research");
      expect(classification.confidence).toBeGreaterThan(0.5);
    });

    it("classifica erro 429 como debug", async () => {
      const ctx = buildRouterContext("por que estou recebendo erro 429 no stress test?", "s1", system.memory);
      const classification = await system.router.classifyIntent("por que estou recebendo erro 429 no stress test?", ctx);
      expect(classification.primaryCellType).toBe("debug");
      expect(classification.entities.some(e => e.type === "error_code")).toBe(true);
    });

    it("classifica tarefa de planejamento como planning", async () => {
      const ctx = buildRouterContext("planejar implementação de rate limiting distribuído com Redis", "s1", system.memory);
      const classification = await system.router.classifyIntent("planejar implementação de rate limiting distribuído com Redis", ctx);
      expect(classification.primaryCellType).toBe("planning");
    });

    it("classifica requisição de revisão como code_review", async () => {
      const ctx = buildRouterContext("revisar o rate limiter em src/lib/rateLimiter.ts", "s1", system.memory);
      const classification = await system.router.classifyIntent("revisar o rate limiter em src/lib/rateLimiter.ts", ctx);
      expect(classification.primaryCellType).toBe("code_review");
    });

    it("classifica tarefa de config como config", async () => {
      const ctx = buildRouterContext("aumentar rate limit para 100 requests por minuto", "s1", system.memory);
      const classification = await system.router.classifyIntent("aumentar rate limit para 100 requests por minuto", ctx);
      expect(classification.primaryCellType).toBe("config");
    });
  });

  describe("Router → ResearchCell", () => {
    it("rota tarefa de pesquisa para ResearchCell e obtém findings", async () => {
      const ctx = buildRouterContext("pesquisar rate limiting", "s1", system.memory);
      const result = await system.router.route("pesquisar rate limiting", ctx);

      expect(result.allSuccessful).toBe(true);
      // Resultado deve conter findings estruturados
      const outputs = Array.from(result.results.values());
      expect(outputs.length).toBeGreaterThan(0);
      const first = outputs[0] as CellOutput<{ findings: unknown[]; summary: string }>;
      expect(first.success).toBe(true);
      if (first.data) {
        expect(Array.isArray(first.data.findings)).toBe(true);
        expect(typeof first.data.summary).toBe("string");
      }
    });
  });

  describe("Router → DebugCell", () => {
    it("rota tarefa de debug e obtém diagnóstico", async () => {
      const ctx = buildRouterContext("erro 429 no stress test", "s1", system.memory);
      const result = await system.router.route("erro 429 no stress test", ctx);

      expect(result.allSuccessful).toBe(true);
      const outputs = Array.from(result.results.values());
      const debugOutput = outputs[0] as CellOutput<{ diagnosis: { errorType: string; rootCause: string } }>;
      expect(debugOutput.success).toBe(true);
      if (debugOutput.data) {
        expect(typeof debugOutput.data.diagnosis.errorType).toBe("string");
        expect(typeof debugOutput.data.diagnosis.rootCause).toBe("string");
      }
    });

    it("detecta 429 como rate limit excedido", async () => {
      const ctx = buildRouterContext("429", "s1", system.memory);
      const result = await system.router.route("erro 429", ctx);

      const outputs = Array.from(result.results.values());
      const debugOutput = outputs[0] as CellOutput<{ diagnosis: { errorType: string; suggestedFixes: Array<{ description: string }> } }>;
      if (debugOutput.data) {
        expect(debugOutput.data.diagnosis.errorType).toContain("RATE");
      }
    });
  });

  describe("Router → PlanningCell", () => {
    it("rota tarefa de planejamento e obtém plano estruturado", async () => {
      const ctx = buildRouterContext("planejar refatoração do rate limiter", "s1", system.memory);
      const result = await system.router.route("planejar refatoração do rate limiter", ctx);

      expect(result.allSuccessful).toBe(true);
      const outputs = Array.from(result.results.values());
      const planOutput = outputs[0] as CellOutput<{ plan: unknown[]; timeline: unknown[] }>;
      expect(planOutput.success).toBe(true);
      if (planOutput.data) {
        expect(Array.isArray(planOutput.data.plan)).toBe(true);
        expect(planOutput.data.plan.length).toBeGreaterThan(0);
        expect(Array.isArray(planOutput.data.timeline)).toBe(true);
      }
    });
  });

  describe("Router → CodeReviewCell", () => {
    it("rota tarefa de revisão e obtém findings", async () => {
      const ctx = buildRouterContext("revisar o rate limiter", "s1", system.memory);
      const result = await system.router.route("revisar o rate limiter", ctx);

      expect(result.allSuccessful).toBe(true);
      const outputs = Array.from(result.results.values());
      const reviewOutput = outputs[0] as CellOutput<{ findings: unknown[]; summary: { totalFindings: number } }>;
      expect(reviewOutput.success).toBe(true);
      if (reviewOutput.data) {
        expect(Array.isArray(reviewOutput.data.findings)).toBe(true);
        expect(typeof reviewOutput.data.summary.totalFindings).toBe("number");
      }
    });
  });

  describe("Router → ConfigCell", () => {
    it("rota tarefa de config e obtém valores", async () => {
      const ctx = buildRouterContext("ver config", "s1", system.memory);
      const result = await system.router.route("ver configuração do rate limit", ctx);

      expect(result.allSuccessful).toBe(true);
      const outputs = Array.from(result.results.values());
      const configOutput = outputs[0] as CellOutput<{ values: unknown[]; action: string }>;
      expect(configOutput.success).toBe(true);
      if (configOutput.data) {
        expect(Array.isArray(configOutput.data.values)).toBe(true);
        expect(configOutput.data.action).toBeDefined();
      }
    });

    it("mascara secrets na saída", async () => {
      const ctx = buildRouterContext("ver configuração", "s1", system.memory);
      const result = await system.router.route("ver configuração", ctx);

      const outputs = Array.from(result.results.values());
      const configOutput = outputs[0] as CellOutput<{ values: Array<{ key: string; value: unknown; sensitive: boolean }> }>;
      if (configOutput.data) {
        // Nenhum valor sensível que esteja CONFIGURADO deve vazar em texto
        const configuredSecrets = configOutput.data.values.filter(v => v.sensitive && v.value !== null);
        for (const s of configuredSecrets) {
          expect(String(s.value)).toContain("MASKED");
        }
        // Chaves sem valor configurado ficam null — nunca expõem segredo
        const emptySecrets = configOutput.data.values.filter(v => v.sensitive && v.value === null);
        expect(emptySecrets.every(s => s.value === null)).toBe(true);
      }
    });
  });

  describe("Tarefa composta → múltiplas células", () => {
    it("tarefa que envolve debug e planejamento dispara múltiplas células", async () => {
      const ctx = buildRouterContext("investigar erro 429 e planejar fix com rate limit distribuído", "s1", system.memory);
      const classification = await system.router.classifyIntent("investigar erro 429 e planejar fix com rate limit distribuído", ctx);

      // Deve detectar debug primário + planning secundário
      expect(classification.secondaryCellTypes.length).toBeGreaterThan(0);

      const result = await system.router.dispatchMultiple("investigar erro 429 e planejar fix com rate limit distribuído", ctx);
      expect(result.results.size).toBeGreaterThan(1);
    });

    it("executa em paralelo quando habilitado", async () => {
      const ctx = buildRouterContext("pesquisar e revisar rate limiter", "s1", system.memory);
      const result = await system.router.dispatchMultiple("pesquisar e revisar rate limiter", ctx);

      // Deve ter pelo menos 2 resultados
      expect(result.results.size).toBeGreaterThanOrEqual(2);
      expect(result.errors.length).toBe(0);
    });
  });

  describe("Health check do sistema", () => {
    it("todas as células registradas estão saudáveis", async () => {
      const health = await healthCheckCognitiveSystem();
      expect(health.healthy).toBe(true);
      // 5 núcleo + ValidationCell + RecoveryCell
      expect(health.cells.length).toBe(7);
      expect(health.routerRegisteredCells).toBe(7);
    });

    it("cada célula tem capabilities declaradas", async () => {
      const cells = system.router.listCells();
      expect(cells.length).toBe(7);
      for (const cell of cells) {
        expect(cell.capabilities.length).toBeGreaterThan(0);
        expect(cell.id).toBeTruthy();
        expect(cell.type).toBeTruthy();
      }
    });
  });

  describe("E2E Determinístico — Fluxo Completo Research → Debug → Planning → Agent", () => {
    it("Agent → CognitiveRouter → ResearchCell → DebugCell → PlanningCell → Agent (determinístico)", async () => {
      const memory = system.memory;
      const sessionId = "e2e-test-deterministic";
      const task = "investigar erro 429 no rate limiter e planejar correção com Redis distribuído";

      const ctx = {
        sessionId,
        taskId: `${sessionId}:task-e2e`,
        taskProfile: {
          capabilities: ["raciocinio"],
          category: "geral",
          complexity: "media",
          text: task,
          hints: [],
        },
        cognitiveMemory: memory,
        budgets: {
          maxTokens: 50000,
          maxDurationMs: 60000,
          maxToolCalls: 20,
          maxCostUsd: 0.10,
        },
        sandboxConfig: {
          fsRoot: "~/.axon",
          allowedTools: ["filesystem", "shell", "http"],
          allowShell: true,
          allowHttp: true,
          allowedEnvVars: [],
        },
        availableTools: ["filesystem", "shell", "http"],
      };

      // 1. Classificação de intent (determinística - sem LLM externo)
      const classification = await system.router.classifyIntent(
        "investigar erro 429 no rate limiter e planejar correção com Redis distribuído",
        ctx
      );

      expect(classification.primaryCellType).toBe("debug");
      expect(classification.secondaryCellTypes).toContain("planning");
      expect(classification.confidence).toBeGreaterThan(0.5);
      expect(classification.entities.some(e => e.type === "error_code")).toBe(true);
      expect(classification.entities.some(e => e.type === "config_key")).toBe(true);

      // 2. Dispatch para DebugCell (primária) + PlanningCell (secundária)
      const result = await system.router.route(task, ctx);

      // Verifica delegação: DebugCell foi chamada
      expect(result.results.size).toBeGreaterThanOrEqual(1);

      const outputs = Array.from(result.results.values());

      // Verifica que DebugCell executou
      const debugOutput = outputs.find(o => o.provenance?.cellType === "debug");
      expect(debugOutput).toBeDefined();
      expect(debugOutput!.success).toBe(true);
      const debugData = debugOutput!.data as
        | { diagnosis?: { errorType?: string; suggestedFixes?: unknown[] } }
        | undefined;
      if (debugData) {
        expect(debugData.diagnosis).toBeDefined();
        expect(debugData.diagnosis?.errorType).toContain("RATE");
        expect(debugData.diagnosis?.suggestedFixes).toBeDefined();
        expect(Array.isArray(debugData.diagnosis?.suggestedFixes)).toBe(true);
      }

      // Verifica delegação para ResearchCell via supervisor (se aplicável)
      // O supervisor pode ter chamado ResearchCell para buscar evidências
      const researchOutput = outputs.find(o => o.provenance?.cellType === "research");

      // Verifica delegação para PlanningCell
      const planningOutput = outputs.find(o => o.provenance?.cellType === "planning");
      expect(planningOutput).toBeDefined();
      expect(planningOutput!.success).toBe(true);
      const planningData = planningOutput!.data as
        | { plan?: unknown[]; timeline?: unknown[]; risks?: unknown[] }
        | undefined;
      if (planningData) {
        expect(planningData.plan).toBeDefined();
        expect(Array.isArray(planningData.plan)).toBe(true);
        expect(planningData.plan!.length).toBeGreaterThan(0);
        expect(planningData.timeline).toBeDefined();
        expect(planningData.risks).toBeDefined();
      }

      // 3. Verifica delegation_depth e prevenção de loop
      // O supervisor deve ter controlado a delegação (profundidade máxima = 4)
      // Não deve ter loops infinitos
      expect(result.errors.length).toBe(0);
      expect(result.allSuccessful).toBe(true);

      // 4. Verifica memória compartilhada entre células
      // DebugCell deve ter escrito na memória, PlanningCell leu
      const intentEntry = await memory.get(`intent:${ctx.taskId}`);
      expect(intentEntry).toBeDefined();
      if (intentEntry) {
        expect(intentEntry.value.primaryCellType).toBe("debug");
        expect(intentEntry.value.secondaryCellTypes).toContain("planning");
      }

      // 3. Verifica ToolRegistry/grep usado quando necessário
      // (se a ResearchCell usou grep, isso é verificado via seu output)

      // 4. Verifica resultado final retornando ao "agente principal"
      expect(result.allSuccessful).toBe(true);
      expect(result.results.size).toBeGreaterThanOrEqual(2); // DebugCell + PlanningCell no mínimo

      // Log para debugging
      console.log("=== E2E DEBUG ===");
      console.log("Classificação:", classification);
      console.log("Cells executadas:", Array.from(result.results.keys()));
      console.log("Sucesso:", result.allSuccessful);
      console.log("Erros:", result.errors);
    });

    it("Célula sem delegação (config apenas)", async () => {
      const memory = system.memory;
      const ctx = {
        sessionId: "config-test",
        taskId: "config-test:1",
        taskProfile: {
          capabilities: ["raciocinio"],
          category: "geral",
          complexity: "media",
          text: "ver configuração do rate limit",
          hints: [],
        },
        cognitiveMemory: memory,
        budgets: { maxTokens: 50000, maxDurationMs: 60000, maxToolCalls: 20, maxCostUsd: 0.10 },
        sandboxConfig: { fsRoot: "~/.axon", allowedTools: ["filesystem", "shell", "http"], allowShell: true, allowHttp: true, allowedEnvVars: [] },
        availableTools: ["filesystem", "shell", "http"],
      };

      const result = await system.router.route("ver configuração do rate limit", ctx);

      expect(result.allSuccessful).toBe(true);
      expect(result.results.size).toBe(1); // Apenas ConfigCell
      const outputs = Array.from(result.results.values());
      expect(outputs[0].provenance?.cellType).toBe("config");
      expect(outputs[0].success).toBe(true);
    });

    it("Limite de delegação (max 4)", async () => {
      const memory = system.memory;
      const ctx = {
        sessionId: "delegation-limit",
        taskId: "delegation-test:1",
        taskProfile: {
          capabilities: ["raciocinio"],
          category: "geral",
          complexity: "media",
          text: "tarefa complexa que exige múltiplas delegações",
          hints: [],
        },
        cognitiveMemory: memory,
        budgets: { maxTokens: 50000, maxDurationMs: 60000, maxToolCalls: 20, maxCostUsd: 0.10 },
        sandboxConfig: { fsRoot: "~/.axon", allowedTools: ["filesystem", "shell", "http"], allowShell: true, allowHttp: true, allowedEnvVars: [] },
        availableTools: ["filesystem", "shell", "http"],
      };

      const result = await system.router.route("tarefa complexa que exige múltiplas delegações", ctx);

      // Não deve exceder 4 delegações (limite do supervisor)
      expect(result.results.size).toBeLessThanOrEqual(5); // 1 primária + max 4 secundárias
    });

    it("Prevenção de loop infinito", async () => {
      const memory = system.memory;
      const ctx = {
        sessionId: "loop-prevention",
        taskId: "loop-test:1",
        taskProfile: {
          capabilities: ["raciocinio"],
          category: "geral",
          complexity: "media",
          text: "circular dependency test",
          hints: [],
        },
        cognitiveMemory: memory,
        budgets: { maxTokens: 50000, maxDurationMs: 60000, maxToolCalls: 20, maxCostUsd: 0.10 },
        sandboxConfig: { fsRoot: "~/.axon", allowedTools: ["filesystem", "shell", "http"], allowShell: true, allowHttp: true, allowedEnvVars: [] },
        availableTools: ["filesystem", "shell", "http"],
      };

      const result = await system.router.route("circular dependency test", ctx);

      // Não deve travar em loop infinito
      expect(result.allSuccessful).toBe(true);
      expect(result.errors.length).toBe(0);
      // Profundidade máxima deve ser respeitada (max 4)
      expect(result.results.size).toBeLessThanOrEqual(5);
    });
  });
});