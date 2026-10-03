import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import authPlugin from "../src/plugins/auth.js";
import modelsRoute from "../src/routes/models.js";
import { MODEL_CATALOG } from "../src/adaptive/modelCatalog.js";
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
  fastify.register(modelsRoute, { providers: map });

  return fastify;
}

describe("GET /v1/models", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejeita requisições sem a chave de API (401)", async () => {
    const fastify = buildTestApp(["openai"]);

    const response = await fastify.inject({
      method: "GET",
      url: "/v1/models",
    });

    expect(response.statusCode).toBe(401);
  });

  it("retorna o shape esperado com os modelos do catálogo", async () => {
    const fastify = buildTestApp(["openai", "groq"]);

    const response = await fastify.inject({
      method: "GET",
      url: "/v1/models",
      headers: { "x-api-key": VALID_KEY },
    });

    expect(response.statusCode).toBe(200);

    const body = response.json<{
      providers: Array<{ provider: string; models: string[] }>;
    }>();

    expect(Array.isArray(body.providers)).toBe(true);

    const providers = body.providers.map((p) => p.provider);
    expect(providers).toContain("openai");
    expect(providers).toContain("groq");
  });

  it("expõe TODOS os providers do catálogo, marcando quais têm chave configurada", async () => {
    const fastify = buildTestApp(["gemini"]);

    const response = await fastify.inject({
      method: "GET",
      url: "/v1/models",
      headers: { "x-api-key": VALID_KEY },
    });

    const body = response.json<{
      providers: Array<{ provider: string; configured: boolean; status: string }>;
    }>();

    const gemini = body.providers.find((p) => p.provider === "gemini");
    expect(gemini?.configured).toBe(true);
    expect(gemini?.status).toBe("configured");

    const others = body.providers.filter((p) => p.provider !== "gemini");
    expect(others.length).toBeGreaterThan(0);
    for (const p of others) {
      expect(p.configured).toBe(false);
      expect(p.status).toBe("not_configured");
    }
  });

  it("os models de cada provider são não-vazios e coerentes com o catálogo", async () => {
    const fastify = buildTestApp(["openai", "groq"]);

    const response = await fastify.inject({
      method: "GET",
      url: "/v1/models",
      headers: { "x-api-key": VALID_KEY },
    });

    const body = response.json<{
      providers: Array<{ provider: string; models: string[] }>;
    }>();

    for (const entry of body.providers) {
      expect(entry.models.length).toBeGreaterThan(0);

      const catalogModels = MODEL_CATALOG.filter(
        (m) => m.provider === entry.provider
      ).map((m) => m.model);

      for (const model of entry.models) {
        expect(catalogModels).toContain(model);
      }
    }
  });
});
