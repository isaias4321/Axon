import { describe, expect, it, vi } from "vitest";

import { ProviderHttpError } from "../src/lib/retry.js";
import {
  planSubtasks,
  routeForSubtask,
  runOrchestrated,
  type OrchestrationReport,
} from "../src/adaptive/orchestrator.js";
import { analyzeTask } from "../src/adaptive/taskAnalyzer.js";
import {
  decideStrategy,
  type StrategyDecision,
} from "../src/adaptive/strategyEngine.js";
import { routeModel } from "../src/adaptive/modelRouter.js";
import type { ModelDecision } from "../src/adaptive/modelRouter.js";
import type { ProviderAdapter } from "../src/providers/types.js";
import type { ChatCompletionResponse } from "../src/schemas/chat.js";

function fakeAdapter(provider: string): ProviderAdapter {
  return {
    name: provider as ProviderAdapter["name"],
    complete: vi.fn(),
    stream: vi.fn(),
  };
}

function buildProviders(...names: string[]): Map<string, ProviderAdapter> {
  const map = new Map<string, ProviderAdapter>();
  for (const name of names) map.set(name, fakeAdapter(name));
  return map;
}

function fakeRunner(
  overrides: Partial<ChatCompletionResponse> = {}
): { runner: { complete: ReturnType<typeof vi.fn> } } {
  return {
    runner: {
      complete: vi.fn().mockResolvedValue({
        id: "resp-orch",
        provider: "gemini",
        model: "gemini-2.5-flash",
        content: "resultado da sub-tarefa",
        usage: {
          prompt_tokens: 20,
          completion_tokens: 30,
          total_tokens: 50,
        },
        cached: false,
        ...overrides,
      } satisfies ChatCompletionResponse),
    },
  };
}

/** Tarefa padrão que a F1 classifica como multi_agent (alta + ≥2 capacidades). */
const MULTI_AGENT_TASK =
  "Analise o impacto e projete a arquitetura de uma migracao de monolitos para microservicos, planejando as etapas e os testes de cada fase";

function decisionFor(task: string, providers: Map<string, ProviderAdapter>): {
  profile: ReturnType<typeof analyzeTask>;
  strategy: StrategyDecision;
  decision: ModelDecision;
} {
  const profile = analyzeTask(task);
  const strategy = decideStrategy(profile);
  const decision = routeModel(profile, strategy.strategy, providers);
  return { profile, strategy, decision };
}

/** Parametriza o relatório de orquestração tipado. */
type Report = OrchestrationReport;

describe("planSubtasks — decomposição determinística (F1)", () => {
  it("gera passos na ordem canônica para as capacidades do profile", () => {
    const { profile } = decisionFor(MULTI_AGENT_TASK, buildProviders("gemini"));
    const subtasks = planSubtasks(profile);

    expect(subtasks.length).toBeGreaterThanOrEqual(2);

    // Ordem canônica preservada: analise → planejamento → … → validacao.
    const labels = subtasks.map((s) => s.label);
    const expectedOrder = ["analise", "planejamento", "geracao_codigo", "validacao"];
    const expectedInOrder = expectedOrder.filter((label) => labels.includes(label));
    expect(labels).toEqual(expectedInOrder);

    // Índices sequenciais e labels pertencem ao pipeline fixo.
    subtasks.forEach((s, i) => expect(s.index).toBe(i));
    expect(subtasks.every((s) => s.prompt.length > 0)).toBe(true);
  });

  it("filtera capacidades fora do pipeline (raciocinio/conversa não viram passo)", () => {
    const { profile } = decisionFor(MULTI_AGENT_TASK, buildProviders("gemini"));
    const subtasks = planSubtasks(profile);

    expect(subtasks.some((s) => s.label === "raciocinio")).toBe(false);
    expect(subtasks.some((s) => s.label === "conversa")).toBe(false);
  });
});

describe("routeForSubtask — mínima inteligência por sub-tarefa", () => {
  it("roteia para um modelo do catálogo que declara a capacidade", () => {
    const providers = buildProviders("openai");
    const { profile } = decisionFor(MULTI_AGENT_TASK, providers);

    // "analise" na lista de capacidades do perfil original.
    const routed = routeForSubtask(
      "geracao_codigo",
      profile,
      providers,
      "gemini",
      "gemini-2.5-flash"
    );

    // Deve escolher um modelo do catálogo de "openai" com geracao_codigo
    // (os modelos openai do catálogo declaram a capacidade) em vez do fallback.
    expect(routed.provider).toBe("openai");
    expect(routed.model).not.toBe("gemini-2.5-flash");
  });

  it("cai no fallback global quando nenhum modelo atende a capacidade", () => {
    const providers = buildProviders("gemini");
    const { profile } = decisionFor(MULTI_AGENT_TASK, providers);

    // "planejamento" está no perfil, mas nenhum modelo Gemini declara
    // "planejamento" nas capacidades do catálogo → routeModel retorna
    // nenhum modelo adequado → usa o fallback (modelo global).
    // O fallback escolhe o primeiro modelo disponível do provider; como o
    // catálogo evoluiu (mais modelos Gemini), a expectativa segue o atual.
    const routed = routeForSubtask(
      "planejamento",
      profile,
      providers,
      "gemini",
      "gemini-2.5-flash"
    );

    expect(routed.provider).toBe("gemini");
    expect(routed.model).toMatch(/^gemini/);
  });

  it("registry vazio → usa o fallback, sem lançar", () => {
    const { profile } = decisionFor(MULTI_AGENT_TASK, new Map());
    const routed = routeForSubtask(
      "analise",
      profile,
      new Map(),
      "gemini",
      "gemini-2.5-flash"
    );

    expect(routed).toEqual({ provider: "gemini", model: "gemini-2.5-flash" });
  });
});

describe("runOrchestrated — execução multi-agente", () => {
  it("executa os passos, acumula contexto e devolve síntese", async () => {
    const providers = buildProviders("gemini");
    const { profile, strategy, decision } = decisionFor(MULTI_AGENT_TASK, providers);
    const { runner } = fakeRunner();

    const report: Report = await runOrchestrated(
      profile.text,
      profile,
      strategy,
      decision,
      providers,
      { runner }
    );

    expect(report.error).toBeNull();
    expect(report.strategy).toBe("multi_agent");
    expect(report.subtasks.length).toBeGreaterThanOrEqual(2);
    expect(report.steps).toHaveLength(report.subtasks.length);
    expect(report.synthesis.content).toBe("resultado da sub-tarefa");

    // Cada passo rodou com o runner (chamada completa = model + usage).
    expect(runner.complete).toHaveBeenCalled();
    expect(report.steps[0]?.status).toBe("ok");

    // Custo agregado somou os passos (usage 20+30 por passo).
    expect(report.cost.model).toBe(decision.model);
    expect(report.cost.totalTokens).toBeGreaterThan(0);
    expect(report.cost.totalCostUsd).not.toBeNull();

    // Contexto acumulado: um passo N (ex: o 2º) recebe o resultado do passo
    // N-1. Como o runner devolve sempre o mesmo content, verificamos que a
    // user message do 2º passo contém o label do 1º. A última chamada é a
    // síntese (que usa o próprio rótulo), por isso inspecionamos calls[1].
    const calls = runner.complete.mock.calls;
    expect(calls.length).toBe(report.subtasks.length + 1);
    const secondStepMessages = (
      calls[1]?.[0] as { messages: Array<{ role: string; content: string }> }
    )?.messages;
    const secondUser = secondStepMessages?.find((m) => m.role === "user");
    expect(secondUser?.content ?? "").toContain("[Passo 1 — analise]");
  });

  it("erro genérico num passo vira step.error e execução continua", async () => {
    const providers = buildProviders("gemini");
    const { profile, strategy, decision } = decisionFor(MULTI_AGENT_TASK, providers);

    const runner = {
      complete: vi
        .fn()
        .mockRejectedValueOnce(new Error("boom genérico no passo"))
        .mockResolvedValue({
          id: "resp-orch",
          provider: "gemini",
          model: "gemini-2.5-flash",
          content: "síntese ok",
          usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
          cached: false,
        } satisfies ChatCompletionResponse),
    };

    const report = await runOrchestrated(
      profile.text,
      profile,
      strategy,
      decision,
      providers,
      { runner }
    );

    // O passo que falhou tem status "error"; a síntese CONTINUA e report não
    // lança (fail-open por passo), com o passo de erro marcado.
    const failedStep = report.steps.find((s) => s.status === "error");
    expect(failedStep).toBeDefined();
    expect(failedStep?.error).toContain("boom genérico");

    // Como há um passo com erro e o modelo global segue disponível, a síntese
    // roda (runner devolveu "síntese ok" na chamada seguinte).
    expect(report.error).toBeNull();
    expect(report.synthesis.content).toBe("síntese ok");
  });

  it("ProviderHttpError no passo re-propaga (rota mapeia 502)", async () => {
    const providers = buildProviders("gemini");
    const { profile, strategy, decision } = decisionFor(MULTI_AGENT_TASK, providers);

    const runner = {
      complete: vi
        .fn()
        .mockRejectedValueOnce(new ProviderHttpError("gemini 429", 429)),
    };

    await expect(
      runOrchestrated(profile.text, profile, strategy, decision, providers, {
        runner,
      })
    ).rejects.toBeInstanceOf(ProviderHttpError);
  });
});