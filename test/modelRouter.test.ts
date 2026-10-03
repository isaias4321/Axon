import { describe, expect, it, vi } from "vitest";
import { routeModel } from "../src/adaptive/modelRouter.js";
import type { ProviderAdapter } from "../src/providers/types.js";
import type { TaskProfile } from "../src/adaptive/taskAnalyzer.js";

function fakeAdapter(provider: string): ProviderAdapter {
  return {
    name: provider as ProviderAdapter["name"],
    complete: vi.fn(),
    stream: vi.fn(),
  };
}

function registryOf(providers: string[]): Map<string, ProviderAdapter> {
  const map = new Map<string, ProviderAdapter>();
  for (const provider of providers) {
    map.set(provider, fakeAdapter(provider));
  }
  return map;
}

function profile(overrides: Partial<TaskProfile>): TaskProfile {
  return {
    text: "tarefa",
    complexity: "media",
    category: "geral",
    capabilities: ["raciocinio"],
    wordCount: 2,
    charCount: 6,
    hints: [],
    ...overrides,
  };
}

describe("routeModel", () => {
  it("escolhe o modelo mais barato e capaz para conversa (openai + groq)", () => {
    const providers = registryOf(["openai", "groq"]);
    const decision = routeModel(
      profile({
        complexity: "baixa",
        category: "conversacao",
        capabilities: ["conversa", "raciocinio"],
      }),
      "single_agent",
      providers
    );

    // openai/gpt-oss-20b (~$0.1875) é o mais barato com as capacidades de
    // conversa exigidas, entre os modelos Groq ainda ativos — llama-3.1-8b-instant
    // foi descontinuado pela Groq em 16/08/2026 (ver modelCatalog.ts).
    expect(decision.status).toBe("ok");
    expect(decision.provider).toBe("groq");
    expect(decision.model).toBe("openai/gpt-oss-20b");
  });

  it("escolhe um modelo com capacidade de código quando a tarefa exige código", () => {
    const providers = registryOf(["openai", "groq"]);
    const decision = routeModel(
      profile({
        complexity: "media",
        category: "codigo",
        capabilities: ["geracao_codigo", "raciocinio"],
      }),
      "single_agent",
      providers
    );

    // gpt-oss-20b não tem geracao_codigo; gpt-4o-mini tem e é barato.
    expect(decision.status).toBe("ok");
    expect(decision.provider).toBe("openai");
    expect(decision.model).toBe("gpt-4o-mini");
  });

  it("retorna nenhum_provedor_disponivel quando o registry está vazio", () => {
    const decision = routeModel(profile({}), "single_agent", new Map());

    expect(decision.status).toBe("nenhum_provedor_disponivel");
    expect(decision.provider).toBeNull();
    expect(decision.model).toBeNull();
    expect(decision.rankedCandidates).toEqual([]);
  });

  it("aplica override de provider, restringindo aos candidatos daquele provider", () => {
    const providers = registryOf(["openai", "anthropic"]);
    const decision = routeModel(
      profile({ category: "planejamento", complexity: "alta" }),
      "multi_agent",
      providers,
      { override: { provider: "anthropic" } }
    );

    expect(decision.status).toBe("ok");
    expect(decision.provider).toBe("anthropic");
  });

  it("retorna forca_invalida para override de modelo inexistente", () => {
    const providers = registryOf(["openai"]);
    const decision = routeModel(
      profile({}),
      "single_agent",
      providers,
      { override: { model: "modelo-inexistente" } }
    );

    expect(decision.status).toBe("forca_invalida");
    expect(decision.model).toBe("modelo-inexistente");
  });

  it("ranqueia candidatos em ordem decrescente de score", () => {
    const providers = registryOf(["openai", "groq"]);
    const decision = routeModel(
      profile({ complexity: "baixa", category: "conversacao" }),
      "single_agent",
      providers
    );

    const scores = decision.rankedCandidates.map((c) => c.score);
    const sorted = [...scores].sort((a, b) => b - a);
    expect(scores).toEqual(sorted);
    expect(decision.rankedCandidates.length).toBeGreaterThan(1);
  });
});
