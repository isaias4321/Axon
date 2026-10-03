import { describe, expect, it, vi } from "vitest";
import { planTask } from "../src/adaptive/planner.js";
import { analyzeTask } from "../src/adaptive/taskAnalyzer.js";
import { detectToolIntent } from "../src/adaptive/taskAnalyzer.js";
import type { ProviderAdapter } from "../src/providers/types.js";
import type { ChatCompletionResponse } from "../src/schemas/chat.js";

function fakeAdapter(provider: string): ProviderAdapter {
  return { name: provider as ProviderAdapter["name"], complete: vi.fn(), stream: vi.fn() };
}

function buildProviders(...names: string[]): Map<string, ProviderAdapter> {
  return new Map(names.map((name) => [name, fakeAdapter(name)]));
}

function fakeRunner(content: string) {
  return {
    complete: vi.fn().mockResolvedValue({
      id: "resp",
      provider: "gemini",
      model: "gemini-2.5-flash",
      content,
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      cached: false,
    } satisfies ChatCompletionResponse),
  };
}

const TASK = "Em modo autonomo, analise, implemente e valide uma função TypeScript";

describe("Planner", () => {
  it("gera plano estruturado a partir do LLM", async () => {
    const providers = buildProviders("gemini");
    const profile = analyzeTask(TASK);
    const runner = fakeRunner(JSON.stringify({
      steps: [
        { id: "s1", index: 0, description: "Analisar", objective: "Entender", capability: "analise", dependencies: [], status: "pending" },
        { id: "s2", index: 1, description: "Implementar", objective: "Código", capability: "geracao_codigo", dependencies: ["s1"], status: "pending" },
      ],
    }));

    const result = await planTask(TASK, profile, runner, providers, "gemini", "gemini-2.5-flash", [], 10);

    expect(result.fallbackUsed).toBe(false);
    expect(result.plan.steps).toHaveLength(2);
    expect(result.plan.steps[0]!.capability).toBe("analise");
    expect(result.plan.steps[1]!.dependencies).toContain("s1");
  });

  it("usa fallback quando LLM falha (JSON inválido)", async () => {
    const providers = buildProviders("gemini");
    const profile = analyzeTask(TASK);
    const runner = fakeRunner("isso não é JSON válido");

    const result = await planTask(TASK, profile, runner, providers, "gemini", "gemini-2.5-flash", [], 10);

    expect(result.fallbackUsed).toBe(true);
    expect(result.plan.steps.length).toBeGreaterThan(0);
  });

  it("usa fallback quando sem provider/modelo", async () => {
    const providers = buildProviders("gemini");
    const profile = analyzeTask(TASK);

    const result = await planTask(TASK, profile, undefined, providers, null, null, [], 10);

    expect(result.fallbackUsed).toBe(true);
    expect(result.plan.steps.length).toBeGreaterThan(0);
  });

  it("valida plano com dependências circulares como inválido (fallback)", async () => {
    const providers = buildProviders("gemini");
    const profile = analyzeTask(TASK);
    const runner = fakeRunner(JSON.stringify({
      steps: [
        { id: "s1", index: 0, description: "A", capability: "analise", dependencies: ["s2"], status: "pending" },
        { id: "s2", index: 1, description: "B", capability: "analise", dependencies: ["s1"], status: "pending" },
      ],
    }));

    const result = await planTask(TASK, profile, runner, providers, "gemini", "gemini-2.5-flash", [], 10);

    expect(result.fallbackUsed).toBe(true);
  });

  it("fallback gera plano baseado em capabilities na ordem lógica", async () => {
    const providers = buildProviders("gemini");
    const profile = analyzeTask("Analise, planeje e implemente código");
    const runner = fakeRunner("invalid");

    const result = await planTask(TASK, profile, runner, providers, "gemini", "gemini-2.5-flash", [], 10);

    expect(result.fallbackUsed).toBe(true);
    const caps = result.plan.steps.map((s) => s.capability);
    // analise deve vir antes de geracao_codigo
    const analiseIdx = caps.indexOf("analise");
    const codigoIdx = caps.indexOf("geracao_codigo");
    expect(analiseIdx).toBeLessThan(codigoIdx);
  });

  it.each([
    "Analisar a estrutura atual do workspace",
    "Mapear o projeto identificando frontend, backend e persistência",
    "Inspecionar o workspace",
  ])("reconhece inspeção de workspace e cria listagem filesystem: %s", async (task) => {
    const profile = analyzeTask(task);
    expect(profile.toolIntent).toBe("filesystem");
    expect(profile.capabilities).toContain("execucao_ferramenta");
    expect(detectToolIntent(task)).toBe("filesystem");

    const result = await planTask(task, profile, fakeRunner(JSON.stringify({
      steps: [
        { id: "analysis", index: 0, description: "Analisar a estrutura", objective: "Interpretar", capability: "analise", dependencies: [], status: "pending" },
      ],
    })), buildProviders("gemini"), "gemini", "gemini-2.5-flash", [], 10);

    expect(result.plan.steps[0]?.capability).toBe("execucao_ferramenta");
    expect(result.plan.steps[0]?.description).toContain("Listar");
  });

  it("corrige etapa de listagem mal rotulada pelo LLM", async () => {
    const task = "Listar recursivamente todos os arquivos e diretórios do workspace atual";
    const profile = analyzeTask(task);
    const result = await planTask(task, profile, fakeRunner(JSON.stringify({
      steps: [
        { id: "list", index: 0, description: "Listar recursivamente todos os arquivos e diretórios do workspace atual", objective: "Mapear a estrutura", capability: "analise", dependencies: [], status: "pending" },
        { id: "analysis", index: 1, description: "Analisar a listagem", objective: "Interpretar", capability: "analise", dependencies: ["list"], status: "pending" },
      ],
    })), buildProviders("gemini"), "gemini", "gemini-2.5-flash", [], 10);

    expect(result.plan.steps[0]?.capability).toBe("execucao_ferramenta");
    expect(result.plan.steps[1]?.capability).toBe("analise");
  });
});
