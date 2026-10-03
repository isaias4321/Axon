import { describe, expect, it, vi } from "vitest";

import { ProviderHttpError } from "../src/lib/retry.js";
import { runAutonomous } from "../src/adaptive/autonomous.js";
import { analyzeTask } from "../src/adaptive/taskAnalyzer.js";
import { decideStrategy } from "../src/adaptive/strategyEngine.js";
import { routeModel } from "../src/adaptive/modelRouter.js";
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

function fakeRunner(responseContent = "Código gerado com sucesso:\n```js\nconsole.log('ok');\n```"): {
  runner: { complete: ReturnType<typeof vi.fn> };
} {
  return {
    runner: {
      complete: vi.fn().mockResolvedValue({
        id: "resp-auto",
        provider: "gemini",
        model: "gemini-2.5-flash",
        content: responseContent,
        usage: {
          prompt_tokens: 15,
          completion_tokens: 25,
          total_tokens: 40,
        },
        cached: false,
      } satisfies ChatCompletionResponse),
    },
  };
}

const AUTONOMOUS_TASK =
  "Construa e otimize em um loop autônomo uma função de validação de formulários com múltiplos critérios e testes em typescript";

describe("Fase 6 — Autonomous Engine (runAutonomous)", () => {
  it("REGRESSÃO — geração de código cortada por limite de tokens continua em vez de reiniciar do zero", async () => {
    // Bug real: max_tokens era baixo demais pra código multi-arquivo, a
    // resposta cortava no meio de uma função, e o finish_reason que a API
    // já retorna (dizendo exatamente isso) nunca era lido em lugar nenhum —
    // uma resposta truncada passava como sucesso completo, sem aviso.
    const task = "Crie um mini projeto Python com uma função de soma e uma de subtração.";
    const profile = analyzeTask(task);
    const strategy = decideStrategy(profile);
    const providers = buildProviders("gemini");
    const decision = routeModel(profile, strategy.strategy, providers);

    const truncatedChunk = "```python\ndef somar(a, b):\n    return a + b\n\ndef subtra";
    const continuationChunk = "ir(a, b):\n    return a - b\n```";
    let callCount = 0;
    let secondCallPrompt = "";

    const runner = {
      complete: vi.fn().mockImplementation(async (request: { messages: Array<{ role: string; content: string }> }) => {
        const system = request.messages.find((m) => m.role === "system")?.content ?? "";
        if (system.includes("PLANNER")) {
          return {
            id: "r-plan",
            provider: "gemini",
            model: "gemini-2.5-flash",
            content: JSON.stringify({
              steps: [
                {
                  id: "s1",
                  index: 0,
                  description: "Gerar o código do mini projeto",
                  objective: "Gerar o código do mini projeto",
                  capability: "geracao_codigo",
                  dependencies: [],
                  status: "pending",
                },
              ],
            }),
            usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
            cached: false,
          } satisfies ChatCompletionResponse;
        }

        callCount += 1;
        if (callCount === 1) {
          // Primeira tentativa: corta no meio, finish_reason="length".
          return {
            id: "r1",
            provider: "gemini",
            model: "gemini-2.5-flash",
            content: truncatedChunk,
            usage: { prompt_tokens: 20, completion_tokens: 8000, total_tokens: 8020 },
            cached: false,
            finishReason: "length",
          } satisfies ChatCompletionResponse;
        }

        // Segunda tentativa (continuação): deve conter o pedido explícito
        // de continuar a partir do conteúdo já gerado.
        secondCallPrompt = request.messages.map((m) => m.content).join("\n");
        return {
          id: "r2",
          provider: "gemini",
          model: "gemini-2.5-flash",
          content: continuationChunk,
          usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
          cached: false,
          finishReason: "stop",
        } satisfies ChatCompletionResponse;
      }),
    };

    const report = await runAutonomous(task, profile, strategy, decision, providers, {
      runner,
      persistMemory: false,
      budgets: { maxIterations: 10, maxCostUsd: 10, maxDurationMs: 30000 },
    });

    // O prompt da 2ª chamada realmente pediu continuação com o conteúdo já
    // gerado — não foi coincidência o teste passar.
    expect(secondCallPrompt).toMatch(/CONTINUAÇÃO OBRIGATÓRIA/);
    expect(secondCallPrompt).toContain(truncatedChunk);

    // O resultado final é a concatenação exata das duas partes — nunca só a
    // última, nem uma regeneração do zero.
    expect(report.finalResult).toBe(truncatedChunk + continuationChunk);
    expect(report.finalResult).toContain("def somar");
    expect(report.finalResult).toContain("def subtrair");
    expect(report.stopReason).toBe("success");
  });

  it("executa o ciclo autônomo com sucesso quando a validação passa", async () => {
    const providers = buildProviders("gemini");
    const profile = analyzeTask(AUTONOMOUS_TASK);
    const strategy = decideStrategy(profile);
    const decision = routeModel(profile, strategy.strategy, providers);
    const { runner } = fakeRunner();

    const report = await runAutonomous(
      profile.text,
      profile,
      strategy,
      decision,
      providers,
      { runner, persistMemory: false }
    );

    expect(report.strategy).toBe("autonomous");
    expect(report.stopReason).toBe("success");
    expect(report.iterations).toBeGreaterThan(0);
    expect(report.finalResult).toContain("console.log('ok')");
    expect(report.error).toBeNull();
    expect(runner.complete).toHaveBeenCalled();
  });

  it("interrompe o loop por limite de iterações (maxIterations)", async () => {
    const providers = buildProviders("gemini");
    const profile = analyzeTask(AUTONOMOUS_TASK);
    const strategy = decideStrategy(profile);
    const decision = routeModel(profile, strategy.strategy, providers);

    // Runner que responde sem código (falha na heurística de código)
    const { runner } = fakeRunner("Resposta vazia e sem estrutura");

    const report = await runAutonomous(
      profile.text,
      profile,
      strategy,
      decision,
      providers,
      {
        runner,
        persistMemory: false,
        budgets: { maxIterations: 2, maxCostUsd: 1, maxDurationMs: 10000 },
      }
    );

    expect(report.strategy).toBe("autonomous");
    expect(report.iterations).toBe(2);
    expect(report.stopReason).toBe("max_iterations");
  });

  it("encerramento real por timeout do budget não é reclassificado como max_iterations", async () => {
    const providers = buildProviders("gemini");
    const profile = analyzeTask(AUTONOMOUS_TASK);
    const strategy = decideStrategy(profile);
    const decision = routeModel(profile, strategy.strategy, providers);

    const runner = {
      complete: vi.fn().mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return {
          id: "resp-timeout",
          provider: "gemini",
          model: "gemini-2.5-flash",
          content: "Código gerado com sucesso:\n```ts\nconst ok = true;\n```",
          usage: { prompt_tokens: 20, completion_tokens: 20, total_tokens: 40 },
          cached: false,
        } satisfies ChatCompletionResponse;
      }),
    };

    const report = await runAutonomous(
      profile.text,
      profile,
      strategy,
      decision,
      providers,
      {
        runner,
        persistMemory: false,
        budgets: { maxIterations: 10, maxCostUsd: 1, maxDurationMs: 5 },
      }
    );

    expect(report.stopReason).toBe("timeout");
    expect(report.error).toContain("timeout");
  });

  it("re-propaga ProviderHttpError para mapeamento de 502 na rota", async () => {
    const providers = buildProviders("gemini");
    const profile = analyzeTask(AUTONOMOUS_TASK);
    const strategy = decideStrategy(profile);
    const decision = routeModel(profile, strategy.strategy, providers);

    const runner = {
      complete: vi.fn().mockRejectedValue(new ProviderHttpError("gemini 429", 429)),
    };

    await expect(
      runAutonomous(profile.text, profile, strategy, decision, providers, {
        runner,
        persistMemory: false,
      })
    ).rejects.toBeInstanceOf(ProviderHttpError);
  });

  it("usa fallback real para outro provider quando o primário é rate-limited (dentro do loop autônomo)", async () => {
    // Reproduz o bug real reportado: com gemini E groq configurados, uma
    // tarefa complexa (loop autônomo) só usava o provider primário e
    // falhava por completo em erro transitório, sem nunca tentar o outro
    // provider configurado — porque o fallback só existia no caminho de
    // execução direta (single_agent), não no planner/executor/validator
    // do loop autônomo.
    const providers = buildProviders("gemini", "groq");
    const profile = analyzeTask(AUTONOMOUS_TASK);
    const strategy = decideStrategy(profile);
    const decision = routeModel(profile, strategy.strategy, providers);
    const primaryProvider = decision.provider;

    const runner = {
      complete: vi.fn().mockImplementation((request: { provider: string }) => {
        if (request.provider === primaryProvider) {
          return Promise.reject(
            new ProviderHttpError(`${primaryProvider} respondeu 429: rate limit`, 429, false)
          );
        }
        return Promise.resolve({
          id: "resp-fallback-autonomous",
          provider: request.provider,
          model: "modelo-fallback",
          content: "Código gerado com sucesso:\n```js\nconsole.log('via fallback');\n```",
          usage: { prompt_tokens: 15, completion_tokens: 25, total_tokens: 40 },
          cached: false,
        } satisfies ChatCompletionResponse);
      }),
    };

    const report = await runAutonomous(
      profile.text,
      profile,
      strategy,
      decision,
      providers,
      { runner, persistMemory: false }
    );

    // O provider primário foi tentado (e falhou) pelo menos uma vez...
    const attemptedProviders = runner.complete.mock.calls.map(
      (call) => (call[0] as { provider: string }).provider
    );
    expect(attemptedProviders).toContain(primaryProvider);
    // ...mas o loop NÃO travou nisso: conseguiu terminar com sucesso,
    // usando o outro provider configurado.
    expect(report.error).toBeNull();
    expect(report.finalResult).toContain("via fallback");
  });
});
