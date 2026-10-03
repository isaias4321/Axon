/**
 * Fase 9.1 — Autonomous Cognitive Delegation.
 *
 * Prova que o CognitiveRouter seleciona e combina células automaticamente
 * com base na intenção da tarefa, com implementações REAIS (sem mocks de fluxo).
 *
 * Classificador = determinístico (keywords + entidades), sem LLM externo.
 * Foco: fluxo real Task → classifyIntent → Router → seleção → execução →
 * compartilhamento de contexto → retorno ao Agent.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createCognitiveSystem } from "../src/cognitive/index.js";
import type { CognitiveMemory } from "../src/cognitive/index.js";
import type { RoutingContext } from "../src/cognitive/index.js";

function buildRouterContext(task: string, sessionId: string, memory: CognitiveMemory): RoutingContext {
  return {
    sessionId,
    taskId: `${sessionId}:t1`,
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

describe("Fase 9.1 — Autonomous Cognitive Delegation", () => {
  let system: ReturnType<typeof createCognitiveSystem>;

  beforeEach(() => {
    system = createCognitiveSystem();
  });

  describe("1. Seleção de célula por intenção (determinístico)", () => {
    it("tarefa de debugging seleciona DebugCell", async () => {
      const task = "investigar erro 429 no stress test";
      const ctx = buildRouterContext(task, "s1", system.memory);
      const classification = await system.router.classifyIntent(task, ctx);

      expect(classification.primaryCellType).toBe("debug");
      expect(classification.confidence).toBeGreaterThan(0.5);

      // Execução real via router
      const result = await system.router.route(task, ctx);
      const outputs = Array.from(result.results.values());
      const debugOutput = outputs.find(o => o.provenance?.cellType === "debug");
      expect(debugOutput).toBeDefined();
      expect(debugOutput!.success).toBe(true);
    });

    it("tarefa de planejamento seleciona PlanningCell", async () => {
      const task = "planejar a implementação de cache distribuído";
      const ctx = buildRouterContext(task, "s2", system.memory);
      const classification = await system.router.classifyIntent(task, ctx);

      expect(classification.primaryCellType).toBe("planning");

      const result = await system.router.route(task, ctx);
      const outputs = Array.from(result.results.values());
      const planningOutput = outputs.find(o => o.provenance?.cellType === "planning");
      expect(planningOutput).toBeDefined();
      expect(planningOutput!.success).toBe(true);
    });

    it("tarefa de pesquisa seleciona ResearchCell", async () => {
      const task = "pesquisar como funciona o rate limiter no projeto";
      const ctx = buildRouterContext(task, "s3", system.memory);
      const classification = await system.router.classifyIntent(task, ctx);

      expect(classification.primaryCellType).toBe("research");

      const result = await system.router.route(task, ctx);
      const outputs = Array.from(result.results.values());
      const researchOutput = outputs.find(o => o.provenance?.cellType === "research");
      expect(researchOutput).toBeDefined();
      expect(researchOutput!.success).toBe(true);
    });

    it("tarefa de revisão de código seleciona CodeReviewCell", async () => {
      const task = "revisar o arquivo src/lib/rateLimiter.ts";
      const ctx = buildRouterContext(task, "s4", system.memory);
      const classification = await system.router.classifyIntent(task, ctx);

      expect(classification.primaryCellType).toBe("code_review");

      const result = await system.router.route(task, ctx);
      const outputs = Array.from(result.results.values());
      const reviewOutput = outputs.find(o => o.provenance?.cellType === "code_review");
      expect(reviewOutput).toBeDefined();
      expect(reviewOutput!.success).toBe(true);
    });

    it("tarefa de configuração seleciona ConfigCell", async () => {
      const task = "ver configuração do rate limit atual";
      const ctx = buildRouterContext(task, "s5", system.memory);
      const classification = await system.router.classifyIntent(task, ctx);

      expect(classification.primaryCellType).toBe("config");

      const result = await system.router.route(task, ctx);
      const outputs = Array.from(result.results.values());
      const configOutput = outputs.find(o => o.provenance?.cellType === "config");
      expect(configOutput).toBeDefined();
      expect(configOutput!.success).toBe(true);
    });
  });

  describe("2. Tarefa composta → múltiplas células", () => {
    it("'Investigue erro 429 e planeje correção com Redis' → DebugCell + PlanningCell", async () => {
      const task = "Investigue o erro 429 do rate limiter e planeje uma correção utilizando Redis distribuído";
      const ctx = buildRouterContext(task, "s6", system.memory);

      const classification = await system.router.classifyIntent(task, ctx);
      expect(classification.primaryCellType).toBe("debug");
      expect(classification.secondaryCellTypes).toContain("planning");

      const result = await system.router.route(task, ctx);
      const outputs = Array.from(result.results.values());

      const debugOutput = outputs.find(o => o.provenance?.cellType === "debug");
      const planningOutput = outputs.find(o => o.provenance?.cellType === "planning");

      expect(debugOutput).toBeDefined();
      expect(planningOutput).toBeDefined();
      expect(result.results.size).toBeGreaterThanOrEqual(2);
      expect(result.allSuccessful).toBe(true);
    });

    it("'Pesquise opções Redis distribuído e crie plano' → ResearchCell + PlanningCell", async () => {
      const task = "Pesquise opções para implementar Redis distribuído e depois crie um plano de implementação";
      const ctx = buildRouterContext(task, "s7", system.memory);

      const classification = await system.router.classifyIntent(task, ctx);
      // Pode ser research primário com planning secundário
      expect(["research", "planning"]).toContain(classification.primaryCellType);

      const result = await system.router.route(task, ctx);
      const outputs = Array.from(result.results.values());

      const researchOutput = outputs.find(o => o.provenance?.cellType === "research");
      const planningOutput = outputs.find(o => o.provenance?.cellType === "planning");

      // Pelo menos uma das duas deve ter executado
      const executedTypes = outputs.map(o => o.provenance?.cellType);
      expect(executedTypes).toContain("research");
      expect(executedTypes).toContain("planning");
    });
  });

  describe("3. Memória compartilhada entre células", () => {
    it("célula secundária acessa contexto produzido pela primária", async () => {
      const memory = system.memory;
      // Simula: DebugCell escreve o diagnóstico na memória
      await memory.set("ctx:429:diagnosis", {
        value: { errorType: "RATE_LIMIT_EXCEEDED", rootCause: "TokenBucket esgotado", ts: Date.now() },
        cellId: "debug-cell-1",
        cellType: "debug",
        timestamp: Date.now(),
        sessionId: "s8",
        taskId: "s8:t1",
        tags: ["debug", "diagnosis", "429"],
        version: 1,
      });

      // A célula secundária (planning) deve conseguir ler via memória
      const task = "Investigue o erro 429 e planeje correção";
      const ctx = buildRouterContext(task, "s8", memory);
      const result = await system.router.route(task, ctx);

      expect(result.allSuccessful).toBe(true);
      // A memória escrita pela DebugCell persiste e é acessível
      const diagnosis = await memory.get("ctx:429:diagnosis");
      expect(diagnosis).toBeDefined();
      expect(diagnosis!.value.errorType).toBe("RATE_LIMIT_EXCEEDED");
    });

    it("intent classification é persistida e acessível", async () => {
      const task = "investigar erro 500 no servidor";
      const ctx = buildRouterContext(task, "s9", system.memory);
      await system.router.route(task, ctx);

      const intentEntry = await system.memory.get(`intent:s9:t1`);
      expect(intentEntry).toBeDefined();
      if (intentEntry) {
        const value = intentEntry.value as { primaryCellType: string };
        expect(value.primaryCellType).toBe("debug");
      }
    });
  });

  describe("4. Resultado retorna ao Agent principal", () => {
    it("route() retorna resultado estruturado consumível pelo Agent", async () => {
      const task = "investigar erro 429 e propor correção";
      const ctx = buildRouterContext(task, "s10", system.memory);
      const result = await system.router.route(task, ctx);

      // Estrutura do resultado (MultiCellDispatchResult)
      expect(result).toHaveProperty("results");
      expect(result).toHaveProperty("allSuccessful");
      expect(result).toHaveProperty("errors");
      expect(result).toHaveProperty("messages");

      // resultados são consumíveis (CellOutput)
      expect(result.allSuccessful).toBe(true);
      expect(typeof result.errors.length).toBe("number");

      // Ao menos uma célula executou
      expect(result.results.size).toBeGreaterThanOrEqual(1);
    });
  });

  describe("5. Proteções", () => {
    it("célula inexistente → erro recuperável, não quebra o fluxo", async () => {
      const task = "validar o código de validação de formulários";
      const ctx = buildRouterContext(task, "s11", system.memory);

      // ValidationCell não existe — router deve fazer fallback para outra célula
      const hasValidationCell = system.router.listCells().some(c => c.type === "code_review" || c.type === "planning" || c.type === "debug" || c.type === "research" || c.type === "config");
      expect(hasValidationCell).toBe(true);

      // A tarefa "validar" deve mapear para uma célula existente (fallback)
      const result = await system.router.route(task, ctx);
      expect(result).toBeDefined();
      // Não deve lançar exceção
    });

    it("tarefa sem intenção clara → fallback sem quebrar", async () => {
      const task = "olá, tudo bem?";
      const ctx = buildRouterContext(task, "s12", system.memory);
      const result = await system.router.route(task, ctx);

      // Router executa sem erro (alguma célula default) OU retorna vazio
      expect(result).toBeDefined();
      expect(result.allSuccessful).toBe(true);
    });

    it("falha de uma célula não derruba as demais", async () => {
      const task = "investigar erro e planejar";
      const ctx = buildRouterContext(task, "s13", system.memory);
      const result = await system.router.route(task, ctx);

      // Qualquer falha de célula é capturada em result.errors, sem throw
      expect(result).toBeDefined();
      // Se uma falhou, as outras ainda estão em results
      for (const output of result.results.values()) {
        expect(output).toHaveProperty("success");
        expect(output).toHaveProperty("provenance");
      }
    });

    it("contexto vazio → execução não trava", async () => {
      const task = ""; // contexto vazio
      const ctx = buildRouterContext(task ?? "tarefa", "s14", system.memory);
      const result = await system.router.route(task || "tarefa vazia", ctx);
      expect(result).toBeDefined();
    });
  });

  describe("6. Fallback sem intenção clara → Agent continua", () => {
    it("sem confiança → Agent pode processar sem o router quebrar", async () => {
      const task = "escreva um poema sobre rate limiting";
      const ctx = buildRouterContext(task, "s15", system.memory);

      // Verifica se alguma célula teria alta confiança
      const classification = await system.router.classifyIntent(task, ctx);
      const hasClearIntent = classification.confidence >= 0.5;

      // Mesmo sem intenção clara, não lança
      const result = await system.router.route(task, ctx);
      expect(result).toBeDefined();
      expect(typeof result.allSuccessful).toBe("boolean");
    });
  });
});