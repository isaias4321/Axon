import Fastify from "fastify";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";

import { TtlCache } from "../src/lib/cache.js";
import { TokenBucketRateLimiter } from "../src/lib/rateLimiter.js";
import authPlugin from "../src/plugins/auth.js";
import chatRoute from "../src/routes/chat.js";
import type { ProviderAdapter } from "../src/providers/types.js";
import type { ChatCompletionResponse } from "../src/schemas/chat.js";

const VALID_KEY = "test-key";

function buildTestApp(options: { maxRequests?: number } = {}) {
  const fastify = Fastify({ logger: false });

  const completeMock: Mock = vi.fn().mockResolvedValue({
    id: "resp-1",
    provider: "openai",
    model: "gpt-4o-mini",
    content: "Olá! Esta é uma resposta de teste.",
    cached: false,
  } satisfies ChatCompletionResponse);

  const fakeAdapter: ProviderAdapter = {
    name: "openai",
    complete: completeMock as ProviderAdapter["complete"],
    stream: vi.fn(),
  };

  const providers = new Map<string, ProviderAdapter>([["openai", fakeAdapter]]);
  const rateLimiter = new TokenBucketRateLimiter(options.maxRequests ?? 100, 60_000);
  const cache = new TtlCache<ChatCompletionResponse>(60_000, 100);

  fastify.register(authPlugin, { validKeys: [VALID_KEY] });
  fastify.register(chatRoute, { providers, rateLimiter, cache });

  return { fastify, completeMock, cache };
}

const validBody = {
  provider: "openai",
  model: "gpt-4o-mini",
  messages: [{ role: "user", content: "Olá!" }],
};

describe("POST /v1/chat/completions", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejeita requisições sem a chave de API (401)", async () => {
    const { fastify } = buildTestApp();
    const response = await fastify.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: validBody,
    });

    expect(response.statusCode).toBe(401);
  });

  it("rejeita chave de API inválida (401)", async () => {
    const { fastify } = buildTestApp();
    const response = await fastify.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "x-api-key": "chave-errada" },
      payload: validBody,
    });

    expect(response.statusCode).toBe(401);
  });

  it("rejeita corpo inválido (400) quando falta 'messages'", async () => {
    const { fastify } = buildTestApp();
    const response = await fastify.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "x-api-key": VALID_KEY },
      payload: { provider: "openai", model: "gpt-4o-mini" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toBe("invalid_request");
  });

  it("retorna 503 quando o provedor solicitado não está configurado", async () => {
    const { fastify } = buildTestApp();
    const response = await fastify.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "x-api-key": VALID_KEY },
      payload: { ...validBody, provider: "anthropic" },
    });

    expect(response.statusCode).toBe(503);
  });

  it("retorna 200 e o conteúdo gerado para uma requisição válida", async () => {
    const { fastify, completeMock } = buildTestApp();
    const response = await fastify.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "x-api-key": VALID_KEY },
      payload: validBody,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ content: string }>().content).toContain("resposta de teste");
    expect(completeMock).toHaveBeenCalledTimes(1);
  });

  it("usa o cache na segunda chamada idêntica, sem invocar o provedor de novo", async () => {
    const { fastify, completeMock } = buildTestApp();

    await fastify.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "x-api-key": VALID_KEY },
      payload: validBody,
    });

    const second = await fastify.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "x-api-key": VALID_KEY },
      payload: validBody,
    });

    expect(second.statusCode).toBe(200);
    expect(second.json<{ cached: boolean }>().cached).toBe(true);
    expect(completeMock).toHaveBeenCalledTimes(1); // só a primeira chamou de verdade
  });

  it("retorna 429 quando o limite de requisições é excedido", async () => {
    const { fastify } = buildTestApp({ maxRequests: 1 });

    await fastify.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "x-api-key": VALID_KEY },
      payload: { ...validBody, temperature: 0.1 }, // corpo diferente, evita cache
    });

    const second = await fastify.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "x-api-key": VALID_KEY },
      payload: { ...validBody, temperature: 0.2 },
    });

    expect(second.statusCode).toBe(429);
  });
});

describe("Fase 3 — campos estimados no /v1/chat/completions", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("1ª chamada → campos de custo estimados presentes", async () => {
    const { fastify } = buildTestApp();
    const response = await fastify.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "x-api-key": VALID_KEY },
      payload: validBody,
    });

    expect(response.statusCode).toBe(200);

    const body = response.json<{
      estimatedInputTokens: number;
      estimatedOutputTokens: number;
      estimatedCostUsd?: number;
    }>();

    expect(body.estimatedInputTokens).toBeGreaterThan(0);
    expect(body.estimatedOutputTokens).toBeGreaterThan(0);
    expect(body.estimatedCostUsd).toBeDefined();
    expect(body.estimatedCostUsd).toBeGreaterThan(0);
  });

  it("2ª chamada idêntica (cache hit) → mesmos valores + cached, provider 1×", async () => {
    const { fastify, completeMock } = buildTestApp();

    const first = await fastify.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "x-api-key": VALID_KEY },
      payload: validBody,
    });

    const second = await fastify.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "x-api-key": VALID_KEY },
      payload: validBody,
    });

    const firstBody = first.json<{ estimatedCostUsd?: number }>();
    const secondBody = second.json<{
      cached: boolean;
      estimatedCostUsd?: number;
    }>();

    expect(secondBody.cached).toBe(true);
    expect(secondBody.estimatedCostUsd).toBe(firstBody.estimatedCostUsd);
    expect(completeMock).toHaveBeenCalledTimes(1); // só a 1ª chamou de verdade
  });

  it("modelo fora do catálogo → sem estimatedCostUsd (nunca null)", async () => {
    const { fastify } = buildTestApp();
    const response = await fastify.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "x-api-key": VALID_KEY },
      payload: { ...validBody, model: "nonexistent-model" },
    });

    expect(response.statusCode).toBe(200);

    const body = response.json<{
      estimatedInputTokens: number;
      estimatedCostUsd?: number;
    }>();

    expect(body.estimatedInputTokens).toBeGreaterThan(0);
    expect("estimatedCostUsd" in body).toBe(false);
  });
});
