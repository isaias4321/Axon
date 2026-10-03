import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildCacheKey, TtlCache } from "../src/lib/cache.js";

describe("TtlCache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("armazena e recupera um valor", () => {
    const cache = new TtlCache<string>(60_000, 100);
    cache.set("k1", "valor");
    expect(cache.get("k1")).toBe("valor");
  });

  it("retorna undefined para chave inexistente", () => {
    const cache = new TtlCache<string>(60_000, 100);
    expect(cache.get("inexistente")).toBeUndefined();
  });

  it("expira o valor após o TTL", () => {
    const cache = new TtlCache<string>(1_000, 100);
    cache.set("k1", "valor");

    vi.advanceTimersByTime(1_001);

    expect(cache.get("k1")).toBeUndefined();
  });

  it("respeita o limite máximo de entradas, descartando a mais antiga", () => {
    const cache = new TtlCache<string>(60_000, 2);
    cache.set("k1", "v1");
    cache.set("k2", "v2");
    cache.set("k3", "v3"); // deve expulsar k1

    expect(cache.get("k1")).toBeUndefined();
    expect(cache.get("k2")).toBe("v2");
    expect(cache.get("k3")).toBe("v3");
    expect(cache.size).toBe(2);
  });
});

describe("buildCacheKey", () => {
  it("gera a mesma chave para objetos com as mesmas propriedades", () => {
    const keyA = buildCacheKey({ model: "gpt-4o", temperature: 0.7 });
    const keyB = buildCacheKey({ temperature: 0.7, model: "gpt-4o" });
    expect(keyA).toBe(keyB);
  });

  it("gera chaves diferentes para conteúdos diferentes", () => {
    const keyA = buildCacheKey({ model: "gpt-4o" });
    const keyB = buildCacheKey({ model: "claude-sonnet-4-6" });
    expect(keyA).not.toBe(keyB);
  });
});
