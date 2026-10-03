import { describe, expect, it } from "vitest";
import { InMemorySessionStore } from "../src/adaptive/memory.js";
import { executeTask, type LLMRunner } from "../src/adaptive/runtime.js";
import type { ProviderAdapter } from "../src/providers/types.js";
import type { ChatCompletionRequest, ChatCompletionResponse } from "../src/schemas/chat.js";

function fakeAdapter(provider: string): ProviderAdapter {
  return {
    name: provider as ProviderAdapter["name"],
    complete: async (req: ChatCompletionRequest): Promise<ChatCompletionResponse> => concreteRunner(req),
    stream: async function* () {
      yield { delta: "", done: true };
    },
  };
}

function buildProviders(...names: string[]): Map<string, ProviderAdapter> {
  return new Map(names.map((name) => [name, fakeAdapter(name)]));
}

function response(content: string, request: ChatCompletionRequest): ChatCompletionResponse {
  return {
    id: "smoke",
    provider: request.provider,
    model: request.model,
    content,
    usage: { prompt_tokens: 20, completion_tokens: 30, total_tokens: 50 },
    cached: false,
  };
}

function concreteRunner(request: ChatCompletionRequest): ChatCompletionResponse {
  const system = request.messages.find((m) => m.role === "system")?.content ?? "";
  if (system.includes("CRITIC") || system.toUpperCase().includes("CRITIC")) {
    return response(JSON.stringify({ passed: true, confidence: 0.95, issues: [], suggestedCorrection: null }), request);
  }
  if (system.includes("PLANNER") || system.toUpperCase().includes("PLANNER")) {
    return response(JSON.stringify({
      steps: [
        { id: "s1", index: 0, description: "Analisar", objective: "Entender", capability: "analise", dependencies: [], status: "pending" },
        { id: "s2", index: 1, description: "Implementar", objective: "Codar", capability: "geracao_codigo", dependencies: ["s1"], status: "pending" },
        { id: "s3", index: 2, description: "Validar", objective: "Checar", capability: "validacao", dependencies: ["s2"], status: "pending" },
      ],
    }), request);
  }
  return response("Resposta:\n```ts\nexport function normalizarEmail(v: string) { return v.trim().toLowerCase(); }\n```", request);
}

const runner: LLMRunner = { complete: concreteRunner };

describe("SMOKE — agent F1-F7 em tarefas reais", () => {
  it("F6 autônomo + F7 hooks (2 execuções acumulando na mesma sessão)", async () => {
    const providers = buildProviders("gemini", "openai");
    const sessionStore = new InMemorySessionStore();
    const task = "Em modo autônomo, analise, planeje, implemente e valide uma função TypeScript para normalizar emails";

    const report = await executeTask(task, providers, { runner, sessionStore, sessionId: "smoke-autonomous", persistAutonomousMemory: false });
    expect(report.execution.strategy).toBe("autonomous");
    expect(report.execution.executed).toBe(true);
    expect(report.autonomous?.stopReason).toBe("success");
    expect(report.autonomous?.stepLogs.length).toBeGreaterThan(0);
    expect(sessionStore.recall("smoke-autonomous").length).toBeGreaterThanOrEqual(1);

    // 2ª execução na mesma sessão — exercita evolução/memória
    const report2 = await executeTask(task, providers, { runner, sessionStore, sessionId: "smoke-autonomous", persistAutonomousMemory: false });
    expect(report2.autonomous?.stopReason).toBe("success");
  });

  it("F5 multi-agente (orquestração)", async () => {
    const providers = buildProviders("gemini", "openai");
    const task = "Projete a arquitetura de uma migração de monólitos para microserviços, planejando etapas detalhadas, testes de contrato e estratégia de rollout";
    const report = await executeTask(task, providers, { runner });
    expect(report.execution.strategy).toBe("multi_agent");
    expect(report.execution.executed).toBe(true);
    expect(report.orchestration?.steps.length).toBeGreaterThanOrEqual(2);
  });

  it("F1-F4 single-agent (função simples) com custo real", async () => {
    const providers = buildProviders("gemini", "openai");
    const task = "Escreva uma função TypeScript que soma dois números";
    const report = await executeTask(task, providers, { runner });
    expect(report.execution.strategy).toBe("single_agent");
    expect(report.execution.executed).toBe(true);
    expect(report.costActual?.totalTokens).toBeGreaterThan(0);
  });
});
