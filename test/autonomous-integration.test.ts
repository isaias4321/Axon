import { describe, expect, it, vi, beforeEach } from "vitest";
import { runAutonomous } from "../src/adaptive/autonomous.js";
import { analyzeTask } from "../src/adaptive/taskAnalyzer.js";
import { decideStrategy } from "../src/adaptive/strategyEngine.js";
import { routeModel } from "../src/adaptive/modelRouter.js";
import type { ProviderAdapter } from "../src/providers/types.js";
import type { ChatCompletionRequest, ChatCompletionResponse } from "../src/schemas/chat.js";
import type { LLMRunner } from "../src/adaptive/runtime.js";
import { setDriverForTest, createInMemoryDriver } from "../src/lib/db/driver.js";
import { memoriesRepo } from "../src/lib/db/index.js";

function fakeAdapter(provider: string): ProviderAdapter {
  return { name: provider as ProviderAdapter["name"], complete: vi.fn(), stream: vi.fn() };
}

function buildProviders(...names: string[]): Map<string, ProviderAdapter> {
  return new Map(names.map((name) => [name, fakeAdapter(name)]));
}

/**
 * Runner que retorna JSON estruturado para planner/critic e código para execução.
 */
function integrationRunner(): LLMRunner {
  return {
    complete: vi.fn(async (request: ChatCompletionRequest): Promise<ChatCompletionResponse> => {
      const system = request.messages.find((m) => m.role === "system")?.content ?? "";

      if (system.includes("PLANNER")) {
        return {
          id: "r",
          provider: request.provider,
          model: request.model,
          content: JSON.stringify({
            steps: [
              { id: "s1", index: 0, description: "Analisar", objective: "Entender", capability: "analise", dependencies: [], status: "pending" },
              { id: "s2", index: 1, description: "Implementar código", objective: "Criar", capability: "geracao_codigo", dependencies: ["s1"], status: "pending" },
              { id: "s3", index: 2, description: "Validar", objective: "Verificar", capability: "validacao", dependencies: ["s2"], status: "pending" },
            ],
          }),
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
          cached: false,
        };
      }

      if (system.includes("CRITIC")) {
        return {
          id: "r",
          provider: request.provider,
          model: request.model,
          content: JSON.stringify({ passed: true, confidence: 0.95, issues: [], suggestedCorrection: null }),
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
          cached: false,
        };
      }

      // Execução normal: retorna código (passa heurística)
      return {
        id: "r",
        provider: request.provider,
        model: request.model,
        content: "Implementação:\n```ts\nexport function x() { return 1; }\n```",
        usage: { prompt_tokens: 15, completion_tokens: 25, total_tokens: 40 },
        cached: false,
      };
    }),
  };
}

const AUTONOMOUS_TASK = "Em modo autonomo, analise, implemente e valide uma função TypeScript";

describe("Fase 6 — Autonomous Integration Scenarios", () => {
  beforeEach(() => {
    // Driver em memória isolado — evita escrita em disco e corrida entre testes
    setDriverForTest(createInMemoryDriver());
  });

  it("Cenário 1: Task simples → sucesso", async () => {
    const providers = buildProviders("gemini");
    const profile = analyzeTask(AUTONOMOUS_TASK);
    const strategy = decideStrategy(profile);
    const decision = routeModel(profile, strategy.strategy, providers);
    const runner = integrationRunner();

    const report = await runAutonomous(profile.text, profile, strategy, decision, providers, {
      runner,
      persistMemory: false,
    });

    expect(report.strategy).toBe("autonomous");
    expect(report.stopReason).toBe("success");
    expect(report.iterations).toBeGreaterThan(0);
    expect(report.finalResult).toContain("export function");
    expect(report.error).toBeNull();
    expect(report.stepLogs.every((s) => s.validation.passed)).toBe(true);
  });

  it("Cenário 2: Task falha → correction → sucesso", async () => {
    const providers = buildProviders("gemini");
    const profile = analyzeTask(AUTONOMOUS_TASK);
    const strategy = decideStrategy(profile);
    const decision = routeModel(profile, strategy.strategy, providers);

    // Runner que falha na primeira tentativa de cada etapa, depois passa
    let callCount = 0;
    const runner: LLMRunner = {
      complete: vi.fn(async (request: ChatCompletionRequest): Promise<ChatCompletionResponse> => {
        callCount++;
        const system = request.messages.find((m) => m.role === "system")?.content ?? "";

        if (system.includes("PLANNER")) {
          return { id: "r", provider: request.provider, model: request.model, content: JSON.stringify({
            steps: [{ id: "s1", index: 0, description: "Implementar", objective: "Código", capability: "geracao_codigo", dependencies: [], status: "pending" }],
          }), usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }, cached: false };
        }

        if (system.includes("CRITIC")) {
          // Na primeira falha, critic sugere correção
          if (callCount < 3) {
            return { id: "r", provider: request.provider, model: request.model, content: JSON.stringify({ passed: false, confidence: 0.5, issues: ["sem código"], suggestedCorrection: "adicione código" }), usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }, cached: false };
          }
          return { id: "r", provider: request.provider, model: request.model, content: JSON.stringify({ passed: true, confidence: 0.9, issues: [], suggestedCorrection: null }), usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }, cached: false };
        }

        // Execução: primeira tentativa sem código, depois com código
        if (callCount < 2) {
          return { id: "r", provider: request.provider, model: request.model, content: "Sem código aqui", usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, cached: false };
        }
        return { id: "r", provider: request.provider, model: request.model, content: "```ts\nconst y = 2;\n```", usage: { prompt_tokens: 15, completion_tokens: 25, total_tokens: 40 }, cached: false };
      }),
    };

    const report = await runAutonomous(profile.text, profile, strategy, decision, providers, {
      runner,
      persistMemory: false,
      budgets: { maxIterations: 10, maxCostUsd: 1, maxDurationMs: 10000, maxToolCalls: 20, maxTokens: 50000 },
    });

    expect(report.stopReason).toBe("success");
    expect(report.finalResult).toContain("const y = 2");
  });

  it("Cenário 3: Task com planner falha → fallback determinístico → sucesso", async () => {
    const providers = buildProviders("gemini");
    const profile = analyzeTask(AUTONOMOUS_TASK);
    const strategy = decideStrategy(profile);
    const decision = routeModel(profile, strategy.strategy, providers);

    // Runner que retorna lixo para o planner (força fallback)
    const runner: LLMRunner = {
      complete: vi.fn(async (request: ChatCompletionRequest): Promise<ChatCompletionResponse> => {
        const system = request.messages.find((m) => m.role === "system")?.content ?? "";
        if (system.includes("PLANNER")) {
          return { id: "r", provider: request.provider, model: request.model, content: "isso não é json", usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 }, cached: false };
        }
        // Retorna texto longo o suficiente para passar heurística de analise
        return { id: "r", provider: request.provider, model: request.model, content: "Análise concluída com sucesso. O código foi implementado:\n```ts\nconst z = 3;\n```", usage: { prompt_tokens: 15, completion_tokens: 25, total_tokens: 40 }, cached: false };
      }),
    };

    const report = await runAutonomous(profile.text, profile, strategy, decision, providers, {
      runner,
      persistMemory: false,
    });

    expect(report.stopReason).toBe("success");
    expect(report.plan.length).toBeGreaterThan(0);
    // O plano veio do fallback (baseado em capabilities)
    expect(report.finalResult).toContain("const z = 3");
  });

  it("Cenário 4: Task com repetição sem progresso → no_progress", async () => {
    const providers = buildProviders("gemini");
    const profile = analyzeTask(AUTONOMOUS_TASK);
    const strategy = decideStrategy(profile);
    const decision = routeModel(profile, strategy.strategy, providers);

    // Runner que sempre retorna erro
    const runner: LLMRunner = {
      complete: vi.fn(async (request: ChatCompletionRequest): Promise<ChatCompletionResponse> => {
        const system = request.messages.find((m) => m.role === "system")?.content ?? "";
        if (system.includes("PLANNER")) {
          return { id: "r", provider: request.provider, model: request.model, content: JSON.stringify({
            steps: [{ id: "s1", index: 0, description: "Analisar", objective: "X", capability: "analise", dependencies: [], status: "pending" }],
          }), usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }, cached: false };
        }
        // Sempre erro
        return { id: "r", provider: request.provider, model: request.model, content: "Erro fatal aconteceu", usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 }, cached: false };
      }),
    };

    const report = await runAutonomous(profile.text, profile, strategy, decision, providers, {
      runner,
      persistMemory: false,
      budgets: { maxIterations: 50, maxCostUsd: 100, maxDurationMs: 100000, maxToolCalls: 100, maxTokens: 500000 },
      config: { noProgressThreshold: 3, enableReplanning: false },
    });

    expect(report.stopReason).toBe("no_progress");
  });

  it("Cenário 5: Task excede maxToolCalls → encerramento", async () => {
    const providers = buildProviders("gemini");
    const profile = analyzeTask(AUTONOMOUS_TASK);
    const strategy = decideStrategy(profile);
    const decision = routeModel(profile, strategy.strategy, providers);

    const runner = integrationRunner();

    const report = await runAutonomous(profile.text, profile, strategy, decision, providers, {
      runner,
      persistMemory: false,
      budgets: { maxIterations: 100, maxCostUsd: 100, maxDurationMs: 100000, maxToolCalls: 2, maxTokens: 500000 },
    });

    expect(report.stopReason).toBe("max_tool_calls");
    expect(report.iterations).toBeLessThanOrEqual(2);
  });

  it("Cenário 6: Memory retrieval utiliza contexto relevante", async () => {
    const providers = buildProviders("gemini");
    const profile = analyzeTask(AUTONOMOUS_TASK);
    const strategy = decideStrategy(profile);
    const decision = routeModel(profile, strategy.strategy, providers);

    // Mock memoriesRepo.searchByTags para retornar memória relevante
    const searchByTagsSpy = vi.spyOn(memoriesRepo, "searchByTags").mockReturnValue([
      {
        id: 1,
        type: "episodic",
        episode_id: 1,
        content_json: JSON.stringify({ task: "similar", lessons: ["use TypeScript"] }),
        embedding_text: "autonomous typescript",
        tags_json: JSON.stringify(["codigo", "geracao_codigo"]),
        relevance_score: 1.0,
        access_count: 0,
        last_accessed: null,
        created_at: 0,
      },
    ]);

    const runner = integrationRunner();

    const report = await runAutonomous(profile.text, profile, strategy, decision, providers, {
      runner,
      persistMemory: false,
    });

    searchByTagsSpy.mockRestore();

    expect(report.stopReason).toBe("success");
    expect(report.finalResult).toContain("export function");
  });
});
