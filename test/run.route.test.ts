import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { InMemorySessionStore } from "../src/adaptive/memory.js";
import type { LLMRunner } from "../src/adaptive/runtime.js";
import { ProviderHttpError } from "../src/lib/retry.js";
import authPlugin from "../src/plugins/auth.js";
import type { ProviderAdapter } from "../src/providers/types.js";
import type { ChatCompletionResponse } from "../src/schemas/chat.js";
import runRoute from "../src/routes/run.js";

const VALID_KEY = "test-key";
const OTHER_KEY = "other-key";

function fakeAdapter(provider: string): ProviderAdapter {
  return {
    name: provider as ProviderAdapter["name"],
    complete: vi.fn(),
    stream: vi.fn(),
  };
}

interface BuildOptions {
  providers?: string[];
  runner?: LLMRunner;
  sessionStore?: InMemorySessionStore;
}

function buildTestApp(options: BuildOptions = {}) {
  const fastify = Fastify({ logger: false });

  const map = new Map<string, ProviderAdapter>();
  for (const provider of options.providers ?? ["openai", "groq"]) {
    map.set(provider, fakeAdapter(provider));
  }

  const runner = options.runner ?? {
    complete: vi.fn().mockResolvedValue({
      id: "resp-run",
      provider: "groq",
      model: "openai/gpt-oss-20b",
      content: "resultado executado da tarefa",
      cached: false,
    } satisfies ChatCompletionResponse),
  };

  fastify.register(authPlugin, { validKeys: [VALID_KEY, OTHER_KEY] });
  fastify.register(runRoute, {
    providers: map,
    runner,
    sessionStore: options.sessionStore,
  });

  return { fastify, runner };
}

const singleBody = {
  task: "Escreva uma função Python que valide um CPF",
};

const multiAgentTask =
  "Analise o impacto e projete a arquitetura de uma migracao de monolitos para microservicos, planejando as etapas e os testes de cada fase";

describe("POST /v1/run", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejeita requisições sem a chave de API (401)", async () => {
    const { fastify } = buildTestApp();
    const response = await fastify.inject({
      method: "POST",
      url: "/v1/run",
      payload: singleBody,
    });

    expect(response.statusCode).toBe(401);
  });

  it("rejeita chave de API inválida (401)", async () => {
    const { fastify } = buildTestApp();
    const response = await fastify.inject({
      method: "POST",
      url: "/v1/run",
      headers: { "x-api-key": "chave-errada" },
      payload: singleBody,
    });

    expect(response.statusCode).toBe(401);
  });

  it("rejeita corpo sem 'task' (400)", async () => {
    const { fastify } = buildTestApp();
    const response = await fastify.inject({
      method: "POST",
      url: "/v1/run",
      headers: { "x-api-key": VALID_KEY },
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toBe("invalid_request");
  });

  it("200 single_agent → execução com estimation e costActual", async () => {
    const { fastify, runner } = buildTestApp();
    const response = await fastify.inject({
      method: "POST",
      url: "/v1/run",
      headers: { "x-api-key": VALID_KEY },
      payload: singleBody,
    });

    expect(response.statusCode).toBe(200);

    const body = response.json<{
      taskProfile: { category: string };
      strategy: { strategy: string };
      decision: { status: string; model: string };
      execution: { executed: boolean; content: string | null; error: string | null };
      estimation: { costUsd: number } | null;
      costActual: { costUsd: number } | null;
      durationMs: number | null;
    }>();

    expect(body.taskProfile.category).toBe("codigo");
    expect(body.strategy.strategy).toBe("single_agent");
    expect(body.decision.status).toBe("ok");
    expect(body.execution.executed).toBe(true);
    expect(body.execution.content).toContain("resultado executado");
    expect(body.execution.error).toBeNull();
    expect(body.estimation?.costUsd).toBeGreaterThan(0);
    expect(body.costActual?.costUsd).toBeGreaterThan(0);
    expect(body.durationMs).toBeGreaterThanOrEqual(0);
    expect((runner.complete as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it("aguarda a execução completa em vez de abortar pela race da rota", async () => {
    const runner: LLMRunner = {
      complete: vi.fn().mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 80));
        return {
          id: "resp-delayed",
          provider: "groq",
          model: "meta-llama/llama-4-scout-17b-16e-instruct",
          content: "resultado executado após atraso",
          cached: false,
        } satisfies ChatCompletionResponse;
      }),
    };

    const { fastify } = buildTestApp({ runner, providers: ["groq"] });
    const startedAt = Date.now();
    const response = await fastify.inject({
      method: "POST",
      url: "/v1/run",
      headers: { "x-api-key": VALID_KEY },
      payload: singleBody,
    });
    const elapsedMs = Date.now() - startedAt;

    expect(response.statusCode).toBe(200);
    expect(elapsedMs).toBeGreaterThanOrEqual(70);
    expect(response.json<{ execution: { executed: boolean; content: string | null } }>().execution.executed).toBe(true);
  });

  it("override de provider não configurado → 200 com execution.error (fail-open)", async () => {
    // Só "gemini" configurado; override pede "anthropic" → forca_invalida.
    // O runtime é fail-open: devolve o relatório com execution.executed=false
    // e a razão da decisão em execution.error (status 200), não 503.
    const { fastify } = buildTestApp({ providers: ["gemini"] });
    const response = await fastify.inject({
      method: "POST",
      url: "/v1/run",
      headers: { "x-api-key": VALID_KEY },
      payload: {
        task: singleBody.task,
        provider: "anthropic",
        model: "claude-sonnet-4-6",
      },
    });

    expect(response.statusCode).toBe(200);

    const body = response.json<{
      decision: { status: string };
      execution: { executed: boolean; error: string };
    }>();
    expect(body.decision.status).toBe("forca_invalida");
    expect(body.execution.executed).toBe(false);
    expect(body.execution.error).toContain("não está no catálogo");
  });

  it("429 quando o runner lança ProviderHttpError 429 (rate limit)", async () => {
    const runner: LLMRunner = {
      complete: vi.fn().mockRejectedValue(new ProviderHttpError("gemini 429", 429)),
    };
    const { fastify } = buildTestApp({ providers: ["gemini"], runner });
    const response = await fastify.inject({
      method: "POST",
      url: "/v1/run",
      headers: { "x-api-key": VALID_KEY },
      payload: singleBody,
    });

    expect(response.statusCode).toBe(429);
    expect(response.json<{ error: string }>().error).toBe("provider_rate_limited");
  });

  it("falha do runner vira execution.error (fail-open), sem 500", async () => {
    const runner: LLMRunner = {
      complete: vi.fn().mockRejectedValue(new Error("boom genérico")),
    };
    const { fastify } = buildTestApp({ providers: ["gemini"], runner });
    const response = await fastify.inject({
      method: "POST",
      url: "/v1/run",
      headers: { "x-api-key": VALID_KEY },
      payload: singleBody,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ execution: { executed: boolean; error: string } }>();
    expect(body.execution.executed).toBe(false);
    expect(body.execution.error).toContain("boom genérico");
  });

  it("multi_agent com override válido executa single_agent (escape hatch)", async () => {
    const { fastify } = buildTestApp();
    const response = await fastify.inject({
      method: "POST",
      url: "/v1/run",
      headers: { "x-api-key": VALID_KEY },
      payload: {
        task: multiAgentTask,
        provider: "openai",
        model: "gpt-4o-mini",
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{
      strategy: { strategy: string };
      execution: { executed: boolean; strategy: string; content: string | null };
      orchestration: unknown;
    }>();

    // Override força o fluxo single_agent — sem orquestração.
    expect(body.strategy.strategy).toBe("multi_agent");
    expect(body.execution.strategy).toBe("single_agent");
    expect(body.execution.executed).toBe(true);
    expect(body.orchestration).toBeUndefined();
  });

  it("200 multi_agent → orquestra agentes especializados e devolve síntese", async () => {
    const { fastify, runner } = buildTestApp();
    const response = await fastify.inject({
      method: "POST",
      url: "/v1/run",
      headers: { "x-api-key": VALID_KEY },
      payload: { task: multiAgentTask },
    });

    expect(response.statusCode).toBe(200);

    const body = response.json<{
      strategy: { strategy: string };
      execution: { executed: boolean; strategy: string; content: string | null; error: string | null };
      orchestration: {
        strategy: string;
        subtasks: Array<{ label: string }>;
        steps: Array<{ status: string; model: string }>;
        synthesis: { content: string };
        cost: { totalTokens: number; totalCostUsd: number | null };
      };
      costActual: { costUsd: number } | null;
    }>();

    expect(body.strategy.strategy).toBe("multi_agent");
    expect(body.execution.executed).toBe(true);
    expect(body.execution.strategy).toBe("multi_agent");
    expect(body.execution.error).toBeNull();
    expect(body.execution.content).toContain("resultado executado");

    // Relatório de orquestração preenchido.
    expect(body.orchestration.strategy).toBe("multi_agent");
    expect(body.orchestration.subtasks.length).toBeGreaterThanOrEqual(2);
    expect(body.orchestration.steps.length).toBeGreaterThanOrEqual(2);
    expect(body.orchestration.synthesis.content).toContain("resultado executado");
    expect(body.orchestration.cost.totalTokens).toBeGreaterThan(0);
    expect(body.orchestration.cost.totalCostUsd).not.toBeNull();
    expect(body.costActual).not.toBeNull();

    // O runner foi chamado em cada passo + síntese.
    expect((runner.complete as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
      body.orchestration.steps.length + 1
    );
  });

  it("429 quando o orchestrator encontra ProviderHttpError 429 (rate limit)", async () => {
    const runner: LLMRunner = {
      complete: vi.fn().mockRejectedValue(new ProviderHttpError("gemini 429", 429)),
    };
    const { fastify } = buildTestApp({ providers: ["gemini"], runner });
    const response = await fastify.inject({
      method: "POST",
      url: "/v1/run",
      headers: { "x-api-key": VALID_KEY },
      payload: { task: multiAgentTask },
    });

    expect(response.statusCode).toBe(429);
    expect(response.json<{ error: string }>().error).toBe("provider_rate_limited");
  });

  it("memória é por chave de API — chaves diferentes têm stores isolados", async () => {
    const sessionStore = new InMemorySessionStore();
    const { fastify } = buildTestApp({ sessionStore });

    // Mesma chave, duas chamadas → acumula na sessão derivada da chave.
    await fastify.inject({
      method: "POST",
      url: "/v1/run",
      headers: { "x-api-key": VALID_KEY },
      payload: singleBody,
    });
    await fastify.inject({
      method: "POST",
      url: "/v1/run",
      headers: { "x-api-key": VALID_KEY },
      payload: { task: "Segunda tarefa" },
    });

    // Outra chave → sessão separada.
    await fastify.inject({
      method: "POST",
      url: "/v1/run",
      headers: { "x-api-key": OTHER_KEY },
      payload: singleBody,
    });

    // A rota deriva a sessão pela chave (request.apiKey) quando não há sessionId.
    // VALID_KEY acumulou 4 turnos (user+assistant de cada chamada); OTHER_KEY só 2.
    expect(sessionStore.recall(VALID_KEY)).toHaveLength(4);
    expect(sessionStore.recall(OTHER_KEY)).toHaveLength(2);
    expect(sessionStore.recall(VALID_KEY)[0]?.role).toBe("user");
    expect(sessionStore.recall(VALID_KEY)[1]?.role).toBe("assistant");
  });

  it("sessionId explícito vence a chave de API como chave da sessão", async () => {
    const sessionStore = new InMemorySessionStore();
    const { fastify } = buildTestApp({ sessionStore });

    await fastify.inject({
      method: "POST",
      url: "/v1/run",
      headers: { "x-api-key": VALID_KEY },
      payload: { ...singleBody, sessionId: "sessao-custom" },
    });

    expect(sessionStore.recall("sessao-custom")).toHaveLength(2);
    expect(sessionStore.recall(VALID_KEY)).toHaveLength(0);
  });
});
