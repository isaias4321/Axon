import { describe, expect, it, vi } from "vitest";

import { InMemorySessionStore } from "../src/adaptive/memory.js";
import { executeTask, type LLMRunner } from "../src/adaptive/runtime.js";
import type { ProviderAdapter } from "../src/providers/types.js";
import type { ChatCompletionRequest, ChatCompletionResponse } from "../src/schemas/chat.js";

function fakeAdapter(provider: string): ProviderAdapter {
  return {
    name: provider as ProviderAdapter["name"],
    complete: vi.fn(),
    stream: vi.fn(),
  };
}

function buildProviders(...names: string[]): Map<string, ProviderAdapter> {
  return new Map(names.map((name) => [name, fakeAdapter(name)]));
}

function response(
  content: string,
  request: ChatCompletionRequest
): ChatCompletionResponse {
  return {
    id: "adaptive-integration",
    provider: request.provider,
    model: request.model,
    content,
    usage: { prompt_tokens: 20, completion_tokens: 30, total_tokens: 50 },
    cached: false,
  };
}

/**
 * Runner determinístico para F4–F6. O Critic da F6 recebe JSON estruturado;
 * os demais agentes recebem uma resposta que satisfaz a heurística de código.
 */
function integrationRunner(): { runner: LLMRunner; complete: ReturnType<typeof vi.fn> } {
  const complete = vi.fn(async (request: ChatCompletionRequest) => {
    const system = request.messages.find((message) => message.role === "system")?.content ?? "";
    if (system.includes("agente CRITIC")) {
      return response(
        JSON.stringify({
          passed: true,
          confidence: 0.95,
          issues: [],
          suggestedCorrection: null,
        }),
        request
      );
    }

    if (system.includes("PLANNER")) {
      // Planner returns structured plan JSON
      return response(
        JSON.stringify({
          steps: [
            {
              id: "step-1",
              index: 0,
              description: "Analisar a tarefa",
              objective: "Entender o que precisa ser feito",
              capability: "analise",
              dependencies: [],
              status: "pending",
            },
            {
              id: "step-2",
              index: 1,
              description: "Implementar a função",
              objective: "Criar código TypeScript",
              capability: "geracao_codigo",
              dependencies: ["step-1"],
              status: "pending",
            },
            {
              id: "step-3",
              index: 2,
              description: "Validar a implementação",
              objective: "Verificar se está correto",
              capability: "validacao",
              dependencies: ["step-2"],
              status: "pending",
            },
          ],
        }),
        request
      );
    }

    return response(
      "Implementação validada:\n```ts\nexport function normalizarEmail(value: string) { return value.trim().toLowerCase(); }\n```",
      request
    );
  });

  return { runner: { complete }, complete };
}

const SINGLE_AGENT_TASK = "Escreva uma função TypeScript que normalize um email";
const MULTI_AGENT_TASK =
  "Analise e projete a arquitetura de uma migracao de monolitos para microservicos, planejando etapas e testes";
const AUTONOMOUS_TASK =
  "Em modo autonomo, analise, planeje, implemente e valide uma funcao TypeScript para normalizar emails";

const AUTONOMOUS_OPTIONS = {
  budgets: { maxIterations: 5, maxCostUsd: 1, maxDurationMs: 10_000 },
  persistAutonomousMemory: false,
};

describe("F1–F6 — pipeline integrado", () => {
  it("mantém decisão, custo, memória, orquestração e autonomia consistentes", async () => {
    const providers = buildProviders("gemini", "openai");
    const sessionStore = new InMemorySessionStore();
    const { runner, complete } = integrationRunner();

    // F1–F4: análise, estratégia single_agent, roteamento F2, custo F3 e memória F4.
    const single = await executeTask(SINGLE_AGENT_TASK, providers, {
      runner,
      sessionStore,
      sessionId: "integrated-session",
      persistAutonomousMemory: false,
    });

    expect(single.taskProfile.category).toBe("codigo");
    expect(single.taskProfile.hints.length).toBeGreaterThan(0);
    expect(single.strategy.strategy).toBe("single_agent");
    expect(single.decision.status).toBe("ok");
    expect(single.decision.provider).not.toBeNull();
    expect(single.decision.model).not.toBeNull();
    expect(single.execution.executed).toBe(true);
    expect(single.estimation?.inputTokens).toBeGreaterThan(0);
    expect(single.costActual?.totalTokens).toBe(50);
    expect(single.costActual?.costUsd).not.toBeNull();
    expect(sessionStore.recall("integrated-session")).toHaveLength(2);

    // F5: mesma cadeia decide → route → runtime usa orquestração sem alterar F4.
    const multi = await executeTask(MULTI_AGENT_TASK, providers, { runner });
    expect(multi.strategy.strategy).toBe("multi_agent");
    expect(multi.execution.strategy).toBe("multi_agent");
    expect(multi.execution.executed).toBe(true);
    expect(multi.orchestration?.steps.length).toBeGreaterThanOrEqual(2);
    expect(multi.orchestration?.synthesis.content).toContain("normalizarEmail");
    expect(multi.orchestration?.cost.totalTokens).toBeGreaterThan(0);

    // F6: gatilho explícito troca APENAS esta execução para loop autônomo.
    const autonomous = await executeTask(AUTONOMOUS_TASK, providers, {
      runner,
      ...AUTONOMOUS_OPTIONS,
    });
    expect(autonomous.strategy.strategy).toBe("autonomous");
    expect(autonomous.execution.strategy).toBe("autonomous");
    expect(autonomous.execution.executed).toBe(true);
    expect(autonomous.autonomous?.stopReason).toBe("success");
    expect(autonomous.autonomous?.stepLogs.length).toBeGreaterThan(0);
    expect(autonomous.autonomous?.stepLogs.every((step) => step.validation.passed)).toBe(true);
    expect(autonomous.autonomous?.totalTokens).toBeGreaterThan(0);
    expect(autonomous.autonomous?.totalCostUsd).not.toBeNull();

    // F4 (1), F5 (passos + síntese), F6 (planner + passos + critics) executaram.
    // Contagem mínima esperada: single(1) + multi_steps + synthesis(1) +
    // planner(1) + stepLogs(steps) + stepLogs(critics, pois complexity alta)
    const expectedMin =
      1 +
      (multi.orchestration?.steps.length ?? 0) +
      1 +
      1 +
      (autonomous.autonomous?.stepLogs.length ?? 0) * 2;
    expect(complete.mock.calls.length).toBeGreaterThanOrEqual(expectedMin);
  });
});
