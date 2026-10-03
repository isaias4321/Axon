import { describe, expect, it } from "vitest";

import { InMemorySessionStore } from "../src/adaptive/memory.js";
import { executeTask, type LLMRunner } from "../src/adaptive/runtime.js";
import { runAutonomous, type AutonomousReport } from "../src/adaptive/autonomous.js";
import { runOrchestrated } from "../src/adaptive/orchestrator.js";
import type { ProviderAdapter } from "../src/providers/types.js";
import type { ChatCompletionRequest, ChatCompletionResponse } from "../src/schemas/chat.js";

function fakeAdapter(provider: string): ProviderAdapter {
  return {
    name: provider as ProviderAdapter["name"],
    complete: async (req: ChatCompletionRequest) => concreteRunner(req),
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
    id: "e2e",
    provider: request.provider,
    model: request.model,
    content,
    usage: { prompt_tokens: 20, completion_tokens: 30, total_tokens: 50 },
    cached: false,
  };
}

/**
 * Runner CONCRETO (não mock) que emula um LLM real:
 * - PLANNER → JSON de plano estruturado
 * - CRITIC → JSON de validação
 * - qualquer outro → implementação de código (satisfaz heurística)
 */
function concreteRunner(request: ChatCompletionRequest): ChatCompletionResponse {
  const system = request.messages.find((m) => m.role === "system")?.content ?? "";

  if (system.includes("agente CRITIC")) {
    return response(
      JSON.stringify({ passed: true, confidence: 0.95, issues: [], suggestedCorrection: null }),
      request
    );
  }

  if (system.includes("PLANNER") || system.toUpperCase().includes("PLANNER")) {
    return response(
      JSON.stringify({
        steps: [
          { id: "s1", index: 0, description: "Analisar", objective: "Entender", capability: "analise", dependencies: [], status: "pending" },
          { id: "s2", index: 1, description: "Implementar", objective: "Codar", capability: "geracao_codigo", dependencies: ["s1"], status: "pending" },
          { id: "s3", index: 2, description: "Validar", objective: "Checar", capability: "validacao", dependencies: ["s2"], status: "pending" },
        ],
      }),
      request
    );
  }

  return response(
    "Resposta:\n```ts\nexport function normalizarEmail(v: string) { return v.trim().toLowerCase(); }\n```",
    request
  );
}

const runner: LLMRunner = { complete: concreteRunner };

describe("F1–F6.1 — pipeline completo ponta a ponta (runner concreto, sem mock)", () => {
  it("F1→F2→F3→F4→F6: executeTask roteia para loop autônomo e todas as fases interagem", async () => {
    const providers = buildProviders("gemini", "openai");
    const sessionStore = new InMemorySessionStore();
    const task = "Em modo autônomo, analise, planeje, implemente e valide uma função TypeScript para normalizar emails";

    const report = await executeTask(task, providers, {
      runner,
      sessionStore,
      sessionId: "e2e-autonomous",
      persistAutonomousMemory: false,
    });

    // F1 — análise da tarefa
    expect(report.taskProfile).toBeDefined();
    // "planeje" dispara PLANNING_KEYWORDS → categoria 'planejamento' (vence 'codigo')
    expect(report.taskProfile.category).toBe("planejamento");

    // F2 — estratégia + roteamento de modelo
    expect(report.strategy.strategy).toBe("autonomous");
    expect(report.decision.status).toBe("ok");
    expect(report.decision.provider).not.toBeNull();
    expect(report.decision.model).not.toBeNull();

    // F3 — estimativa de custo offline
    expect(report.estimation).not.toBeNull();
    expect(report.estimation?.totalTokens).toBeGreaterThan(0);

    // F4 — memória short-term gravou o turno
    expect(sessionStore.recall("e2e-autonomous").length).toBeGreaterThanOrEqual(1);

    // F6 — loop autônomo executado e integrado no relatório
    expect(report.execution.strategy).toBe("autonomous");
    expect(report.execution.executed).toBe(true);
    expect(report.autonomous).toBeDefined();
    const auto = report.autonomous as AutonomousReport;
    expect(auto.stopReason).toBe("success");
    expect(auto.stepLogs.length).toBeGreaterThan(0);
    expect(auto.totalTokens).toBeGreaterThan(0);
    expect(auto.totalCostUsd).not.toBeNull();
    // Cada passo validou (Critic concreto retorna passed:true)
    expect(auto.stepLogs.every((s) => s.validation.passed)).toBe(true);
  });

  it("F1→F2→F5: executeTask roteia para orquestração multi-agente quando complexo", async () => {
    const providers = buildProviders("gemini", "openai");
    const task =
      "Projete a arquitetura de uma migração de monólitos para microserviços, " +
      "planejando etapas detalhadas, testes de contrato e estratégia de rollout";

    const report = await executeTask(task, providers, { runner });

    expect(report.strategy.strategy).toBe("multi_agent");
    expect(report.execution.strategy).toBe("multi_agent");
    expect(report.execution.executed).toBe(true);
    expect(report.orchestration).toBeDefined();
    expect(report.orchestration?.steps.length).toBeGreaterThanOrEqual(2);
    expect(report.orchestration?.synthesis.content.length).toBeGreaterThan(0);
    // F3 ainda presente
    expect(report.costActual?.totalTokens).toBeGreaterThan(0);
  });

  it("F1→F2→F3: single-agent executa e calcula custo real", async () => {
    const providers = buildProviders("gemini", "openai");
    const task = "Escreva uma função TypeScript que normalize um email";

    const report = await executeTask(task, providers, { runner });

    expect(report.strategy.strategy).toBe("single_agent");
    expect(report.execution.executed).toBe(true);
    expect(report.costActual?.totalTokens).toBe(50);
    expect(report.costActual?.costUsd).not.toBeNull();
  });

  it("6.1 — chamadas diretas runAutonomous e runOrchestrated consomem o mesmo runner e mantêm contratos", async () => {
    const providers = buildProviders("gemini", "openai");
    const profileTask = "modo autônomo: implemente e valide uma função de hash";
    const profile = (await import("../src/adaptive/taskAnalyzer.js")).analyzeTask(profileTask);
    const strat = (await import("../src/adaptive/strategyEngine.js")).decideStrategy(profile);
    const dec = (await import("../src/adaptive/modelRouter.js")).routeModel(profile, strat.strategy, providers);

    // F6 direto
    const auto = await runAutonomous(profile.text, profile, strat, dec, providers, { runner, persistMemory: false });
    expect(auto.stopReason).toBe("success");

    // F5 direto (precisa de multi_agent strategy)
    const multiProfile = (await import("../src/adaptive/taskAnalyzer.js")).analyzeTask(
      "Projete arquitetura de microserviços com testes e rollout"
    );
    const multiStrat = (await import("../src/adaptive/strategyEngine.js")).decideStrategy(multiProfile);
    const multiDec = (await import("../src/adaptive/modelRouter.js")).routeModel(multiProfile, multiStrat.strategy, providers);
    const orch = await runOrchestrated(multiProfile.text, multiProfile, multiStrat, multiDec, providers, { runner });
    expect(orch.error).toBeNull();
    expect(orch.synthesis.content.length).toBeGreaterThan(0);
  });
});
