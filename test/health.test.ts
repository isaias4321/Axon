import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkProviderHealth,
  clearHealthCache,
  filterHealthyProviders,
} from "../src/providers/health.js";
import type { ProviderAdapter } from "../src/providers/types.js";

function fakeAdapter(
  provider: string,
  health?: ProviderAdapter["health"]
): ProviderAdapter {
  return {
    name: provider as ProviderAdapter["name"],
    complete: vi.fn(),
    stream: vi.fn(),
    ...(health ? { health } : {}),
  };
}

describe("checkProviderHealth", () => {
  it("adapter sem health() é saudável por padrão, sem rede", async () => {
    const report = await checkProviderHealth(fakeAdapter("openai"));

    expect(report.healthy).toBe(true);
    expect(report.latencyMs).toBeNull();
    expect(report.provider).toBe("openai");
  });

  it("adapter com health() que resolve é saudável com latência", async () => {
    const report = await checkProviderHealth(
      fakeAdapter("gemini", async () => {})
    );

    expect(report.healthy).toBe(true);
    expect(report.latencyMs).not.toBeNull();
  });

  it("adapter com health() que lança é marcado como doente com o erro", async () => {
    const report = await checkProviderHealth(
      fakeAdapter("groq", async () => {
        throw new Error("401 unauthorized");
      })
    );

    expect(report.healthy).toBe(false);
    expect(report.error).toContain("401");
  });
});

describe("filterHealthyProviders", () => {
  beforeEach(() => {
    clearHealthCache();
  });

  it("filtra provedores doentes e preserva saudáveis, sem mutar o registry", async () => {
    const providers = new Map<string, ProviderAdapter>([
      ["openai", fakeAdapter("openai")], // sem health → saudável
      ["gemini", fakeAdapter("gemini", async () => {})], // saudável
      ["groq", fakeAdapter("groq", async () => { throw new Error("down"); })], // doente
    ]);

    const { available, reports } = await filterHealthyProviders(providers);

    expect(Array.from(available.keys()).sort()).toEqual(["gemini", "openai"]);
    expect(reports).toHaveLength(3);

    const groqReport = reports.find((r) => r.provider === "groq");
    expect(groqReport?.healthy).toBe(false);

    // O registry original não foi mutado.
    expect(providers.size).toBe(3);
  });

  it("copia o mapa de disponíveis (novo Map, não o original)", async () => {
    const providers = new Map<string, ProviderAdapter>([
      ["openai", fakeAdapter("openai")],
    ]);

    const { available } = await filterHealthyProviders(providers);

    expect(available).not.toBe(providers);
    expect(available.get("openai")).toBe(providers.get("openai"));
  });

  it("usa o cache por TTL — 2ª chamada não re-invoca health()", async () => {
    const health = vi.fn(async () => {});
    const providers = new Map<string, ProviderAdapter>([
      ["gemini", fakeAdapter("gemini", health)],
    ]);
    const now = 1_000_000;
    const options = { now: () => now, ttlMs: 30_000 };

    await filterHealthyProviders(providers, options);
    await filterHealthyProviders(providers, options);

    expect(health).toHaveBeenCalledTimes(1);
  });

  it("TTL expirado re-checa o provedor", async () => {
    const health = vi.fn(async () => {});
    const providers = new Map<string, ProviderAdapter>([
      ["gemini", fakeAdapter("gemini", health)],
    ]);
    let now = 1_000_000;
    const options = { now: () => now, ttlMs: 30_000 };

    await filterHealthyProviders(providers, options);
    now += 31_000; // passou do TTL
    await filterHealthyProviders(providers, options);

    expect(health).toHaveBeenCalledTimes(2);
  });
});
