import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import authPlugin from "../src/plugins/auth.js";
import decideRoute from "../src/routes/decide.js";
import type { ProviderAdapter } from "../src/providers/types.js";

const VALID_KEY = "test-key";

function fakeAdapter(provider: string): ProviderAdapter {
  return {
    name: provider as ProviderAdapter["name"],
    complete: vi.fn(),
    stream: vi.fn(),
  };
}

function buildTestApp(providers: string[]) {
  const fastify = Fastify({ logger: false });

  const map = new Map<string, ProviderAdapter>();
  for (const provider of providers) {
    map.set(provider, fakeAdapter(provider));
  }

  fastify.register(authPlugin, { validKeys: [VALID_KEY] });
  fastify.register(decideRoute, { providers: map });

  return fastify;
}

const validBody = {
  task: "Construa uma arquitetura de microsserviços em Python FastAPI com Postgres e Docker",
};

describe("POST /v1/decide", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejeita requisições sem a chave de API (401)", async () => {
    const fastify = buildTestApp(["openai", "groq"]);

    const response = await fastify.inject({
      method: "POST",
      url: "/v1/decide",
      payload: validBody,
    });

    expect(response.statusCode).toBe(401);
  });

  it("rejeita chave de API inválida (401)", async () => {
    const fastify = buildTestApp(["openai", "groq"]);

    const response = await fastify.inject({
      method: "POST",
      url: "/v1/decide",
      headers: { "x-api-key": "chave-errada" },
      payload: validBody,
    });

    expect(response.statusCode).toBe(401);
  });

  it("rejeita corpo sem 'task' (400)", async () => {
    const fastify = buildTestApp(["openai", "groq"]);

    const response = await fastify.inject({
      method: "POST",
      url: "/v1/decide",
      headers: { "x-api-key": VALID_KEY },
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toBe("invalid_request");
  });

  it("retorna 200 com a decisão completa para uma requisição válida", async () => {
    const fastify = buildTestApp(["openai", "groq"]);

    const response = await fastify.inject({
      method: "POST",
      url: "/v1/decide",
      headers: { "x-api-key": VALID_KEY },
      payload: validBody,
    });

    expect(response.statusCode).toBe(200);

    const body = response.json<{
      taskProfile: { category: string };
      strategy: { strategy: string };
      decision: {
        provider: string;
        status: string;
        rankedCandidates: Array<{ score: number }>;
      };
    }>();

    expect(typeof body.taskProfile.category).toBe("string");
    expect(typeof body.strategy.strategy).toBe("string");
    expect(typeof body.decision.provider).toBe("string");
    expect(Array.isArray(body.decision.rankedCandidates)).toBe(true);

    if (body.decision.rankedCandidates.length >= 2) {
      expect(body.decision.rankedCandidates[0]?.score).toBeGreaterThan(
        body.decision.rankedCandidates[1]?.score
      );
    }
  });

  it("retorna 200 com status 'nenhum_provedor_disponivel' quando o registry está vazio", async () => {
    const fastify = buildTestApp([]);

    const response = await fastify.inject({
      method: "POST",
      url: "/v1/decide",
      headers: { "x-api-key": VALID_KEY },
      payload: validBody,
    });

    expect(response.statusCode).toBe(200);
    expect(
      response.json<{ decision: { status: string } }>().decision.status
    ).toBe("nenhum_provedor_disponivel");
  });
});

describe("Fase 3 — bloco estimation no /v1/decide", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("status ok → estimation presente, coerente com a decisão", async () => {
    const fastify = buildTestApp(["openai", "groq"]);

    const response = await fastify.inject({
      method: "POST",
      url: "/v1/decide",
      headers: { "x-api-key": VALID_KEY },
      payload: validBody,
    });

    expect(response.statusCode).toBe(200);

    const body = response.json<{
      decision: { model: string; status: string };
      estimation: {
        model: string;
        inputTokens: number;
        totalTokens: number;
        costUsd: number | null;
        inputCostPer1MTokens: number;
      };
    }>();

    expect(body.decision.status).toBe("ok");
    expect(body.estimation.model).toBe(body.decision.model);
    expect(body.estimation.inputTokens).toBeGreaterThan(0);
    expect(body.estimation.totalTokens).toBe(body.estimation.inputTokens);
    expect(body.estimation.costUsd).toBeGreaterThan(0);
    expect(body.estimation.inputCostPer1MTokens).toBeGreaterThan(0);
  });

  it("registry vazio → estimation null", async () => {
    const fastify = buildTestApp([]);

    const response = await fastify.inject({
      method: "POST",
      url: "/v1/decide",
      headers: { "x-api-key": VALID_KEY },
      payload: validBody,
    });

    expect(response.statusCode).toBe(200);

    const body = response.json<{ estimation: unknown }>();
    expect(body.estimation).toBeNull();
  });
});
