import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import authPlugin from "../src/plugins/auth.js";
import decideRoute from "../src/routes/decide.js";
import type { HealthChecker } from "../src/providers/health.js";
import type { ProviderAdapter } from "../src/providers/types.js";

const VALID_KEY = "test-key";

function fakeAdapter(provider: string): ProviderAdapter {
  return {
    name: provider as ProviderAdapter["name"],
    complete: vi.fn(),
    stream: vi.fn(),
  };
}

function buildTestApp(
  providers: string[],
  healthChecker?: HealthChecker
) {
  const fastify = Fastify({ logger: false });

  const map = new Map<string, ProviderAdapter>();
  for (const provider of providers) {
    map.set(provider, fakeAdapter(provider));
  }

  fastify.register(authPlugin, { validKeys: [VALID_KEY] });
  fastify.register(decideRoute, { providers: map, healthChecker });

  return fastify;
}

const validBody = {
  task: "Construa uma arquitetura de microsserviços em Python FastAPI",
};

describe("POST /v1/decide com healthChecker", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rota só sobre provedores saudáveis quando o healthChecker derruba um", async () => {
    // healthChecker fake: derruba "groq", mantém "openai". Sem rede.
    const healthChecker: HealthChecker = async (providers) => {
      const available = new Map<string, ProviderAdapter>();
      const reports = [];

      for (const [name, adapter] of providers) {
        const healthy = name !== "groq";
        reports.push({
          provider: name,
          healthy,
          latencyMs: 1,
          checkedAt: new Date().toISOString(),
        });
        if (healthy) available.set(name, adapter);
      }

      return { available, reports };
    };

    const fastify = buildTestApp(["openai", "groq"], healthChecker);

    const response = await fastify.inject({
      method: "POST",
      url: "/v1/decide",
      headers: { "x-api-key": VALID_KEY },
      payload: validBody,
    });

    expect(response.statusCode).toBe(200);

    const body = response.json<{
      decision: { provider: string; status: string };
      health: Array<{ provider: string; healthy: boolean }>;
    }>();

    expect(body.decision.status).toBe("ok");
    expect(body.decision.provider).toBe("openai");
    expect(body.health).toHaveLength(2);

    const groq = body.health.find((h) => h.provider === "groq");
    expect(groq?.healthy).toBe(false);
  });

  it("todos os provedores doentes → nenhum_provedor_disponivel", async () => {
    const healthChecker: HealthChecker = async (providers) => {
      const reports = Array.from(providers.keys()).map((provider) => ({
        provider,
        healthy: false,
        latencyMs: 1,
        checkedAt: new Date().toISOString(),
      }));
      return { available: new Map(), reports };
    };

    const fastify = buildTestApp(["openai", "groq"], healthChecker);

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
