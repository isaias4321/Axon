import { describe, expect, it } from "vitest";
import { buildProviderRegistry } from "../src/providers/registry.js";
import type { Env } from "../src/config.js";

function fakeEnv(overrides: Partial<Env> = {}): Env {
  return {
    PORT: 3000,
    HOST: "0.0.0.0",
    LOG_LEVEL: "info",
    GATEWAY_API_KEYS: ["dev-key"],
    RATE_LIMIT_MAX_REQUESTS: 20,
    RATE_LIMIT_WINDOW_MS: 60_000,
    CACHE_TTL_MS: 300_000,
    CACHE_MAX_ENTRIES: 500,
    ...overrides,
  };
}

describe("buildProviderRegistry", () => {
  it("não registra nenhum provedor se nenhuma chave estiver configurada", () => {
    const registry = buildProviderRegistry(fakeEnv());
    expect(registry.size).toBe(0);
  });

  it("registra apenas os provedores com chave configurada", () => {
    const registry = buildProviderRegistry(
      fakeEnv({ OPENAI_API_KEY: "sk-x", GROQ_API_KEY: "gsk-x" })
    );

    expect(Array.from(registry.keys()).sort()).toEqual(["groq", "openai"]);
  });

  it("registra os 4 provedores suportados quando todas as chaves estão presentes", () => {
    const registry = buildProviderRegistry(
      fakeEnv({
        OPENAI_API_KEY: "sk-x",
        ANTHROPIC_API_KEY: "ak-x",
        GEMINI_API_KEY: "gk-x",
        GROQ_API_KEY: "gsk-x",
      })
    );

    expect(Array.from(registry.keys()).sort()).toEqual(["anthropic", "gemini", "groq", "openai"]);
    for (const [key, adapter] of registry) {
      expect(adapter.name).toBe(key);
    }
  });
});
