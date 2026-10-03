import { describe, expect, it, vi } from "vitest";
import { executeOneStep, buildToolInput, deriveFileRead, deriveFileWrite } from "../src/adaptive/executor.js";
import { analyzeTask } from "../src/adaptive/taskAnalyzer.js";
import type { ProviderAdapter } from "../src/providers/types.js";
import type { ChatCompletionRequest, ChatCompletionResponse } from "../src/schemas/chat.js";
import type { PlanStep } from "../src/adaptive/types.js";

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

const TASK = "Em modo autonomo, implemente uma função";

function makeStep(capability: PlanStep["capability"]): PlanStep {
  return {
    id: "step-1",
    index: 0,
    description: "Executar etapa",
    objective: "Objetivo",
    capability,
    dependencies: [],
    status: "pending",
    attempts: 0,
    maxAttempts: 3,
  };
}

describe("Executor", () => {
  it("executa uma etapa via LLM e retorna Observation", async () => {
    const providers = buildProviders("gemini");
    const profile = analyzeTask(TASK);
    const runner = fakeRunner("```ts\nconst x = 1;\n```");
    const step = makeStep("geracao_codigo");

    const result = await executeOneStep(step, TASK, profile, {
      runner,
      providers,
    });

    expect(result.observation.success).toBe(true);
    expect(result.observation.output).toContain("const x = 1");
    expect(result.observation.toolName).toBe("llm:gemini");
    expect(result.estimatedTokens.total).toBeGreaterThan(0);
  });

  it("envia política explícita sem tool-calling e trata evidence como dados", async () => {
    const providers = buildProviders("gemini");
    const profile = analyzeTask("Analise o resultado da leitura do arquivo");
    const runner = {
      complete: vi.fn().mockResolvedValue({
        id: "resp-analysis",
        provider: "gemini",
        model: "gemini-2.5-flash",
        content: "A evidência mostra a estrutura da camada de persistência.",
        cached: false,
      } satisfies ChatCompletionResponse),
    };

    await executeOneStep(makeStep("analise"), "Analise o arquivo", profile, {
      runner,
      providers,
      accumulatedContext: [
        '[Evidência filesystem]: {"tool":"filesystem","action":"read","path":"src/lib/db/driver.ts"}',
      ],
    });

    const request = runner.complete.mock.calls[0]?.[0] as { messages: Array<{ content: string }>; tool_choice: string };
    expect(request.tool_choice).toBe("none");
    expect(request.messages.map((message) => message.content).join("\n")).toContain("filesystem");
    expect(request.messages.map((message) => message.content).join("\n")).toContain("não emita chamadas de ferramentas");
  });

  it("limita o contexto grande e não duplica evidence no system prompt", async () => {
    const providers = buildProviders("gemini");
    const profile = analyzeTask("Gere código com base nas evidências");
    const runner = fakeRunner("```ts\nconst ok = true;\n```");
    const evidence = "x".repeat(20_000);

    await executeOneStep(makeStep("geracao_codigo"), "Gere código", profile, {
      runner,
      providers,
      accumulatedContext: [`[Evidência filesystem]: ${evidence}`],
    });

    const request = runner.complete.mock.calls[0]?.[0] as ChatCompletionRequest;
    const system = request.messages.find((message) => message.role === "system")?.content ?? "";
    const user = request.messages.find((message) => message.role === "user")?.content ?? "";
    expect(system).not.toContain("x".repeat(500));
    expect(user.length).toBeLessThan(14_000);
    expect(user).toContain("Contexto truncado pelo limite seguro");
  });

  it("retorna erro estruturado quando LLM falha", async () => {
    const providers = buildProviders("gemini");
    const profile = analyzeTask(TASK);
    const runner = {
      complete: vi.fn().mockRejectedValue(new Error("boom")),
    };
    const step = makeStep("analise");

    const result = await executeOneStep(step, TASK, profile, {
      runner,
      providers,
    });

    expect(result.observation.success).toBe(false);
    expect(result.observation.error).toBe("boom");
  });

  it("re-propaga ProviderHttpError", async () => {
    const { ProviderHttpError } = await import("../src/lib/retry.js");
    const providers = buildProviders("gemini");
    const profile = analyzeTask(TASK);
    const runner = {
      complete: vi.fn().mockRejectedValue(new ProviderHttpError("429", 429)),
    };
    const step = makeStep("analise");

    await expect(
      executeOneStep(step, TASK, profile, { runner, providers })
    ).rejects.toBeInstanceOf(ProviderHttpError);
  });

  it("estima tokens e custo corretamente", async () => {
    const providers = buildProviders("gemini");
    const profile = analyzeTask(TASK);
    const runner = fakeRunner("Resultado da etapa");
    const step = makeStep("raciocinio");

    const result = await executeOneStep(step, TASK, profile, {
      runner,
      providers,
    });

    expect(result.estimatedTokens.input).toBeGreaterThan(0);
    expect(result.estimatedTokens.output).toBeGreaterThan(0);
    // estimatedCostUsd é null se o modelo não estiver no catálogo, senão número
    expect(result.estimatedCostUsd === null || typeof result.estimatedCostUsd === "number").toBe(true);
  });
});

describe("buildToolInput / derivação de caminho — regressão", () => {
  function makeStep(description: string, capability: PlanStep["capability"] = "execucao_ferramenta"): PlanStep {
    return {
      id: "s1",
      index: 0,
      description,
      objective: description,
      capability,
      dependencies: [],
      status: "pending",
      attempts: 0,
      maxAttempts: 3,
    };
  }

  it("não trata o nome da própria ferramenta como caminho (filesystem.list)", () => {
    // Bug real: uma etapa descrita como "Executar filesystem.list no
    // diretório /app" fazia o extrator escolher "filesystem.list" como o
    // PATH — a tool tentava listar "/app/filesystem.list" ("File not
    // found") em vez do diretório real pedido.
    const desc = "Executar filesystem.list no diretório /app";
    const result = buildToolInput("filesystem", makeStep(desc), desc, { filesystemIntent: "list" });
    expect(result).toEqual({ success: true, action: "list", value: { path: "/app", recursive: false } });
  });

  it("não trata a menção a filesystem.write como pedido de escrita", () => {
    // Bug real (mais grave): uma etapa de VERIFICAÇÃO que apenas menciona
    // "filesystem.write" (ex.: "confirme que filesystem.write não rodou")
    // podia ser lida como um pedido de escrita real nesse "arquivo".
    const desc = "Verifique se filesystem.write foi executado e se writeAllowed permaneceu falso";
    expect(deriveFileWrite(desc)).toBeNull();
  });

  it("preserva a barra inicial de um caminho absoluto (/app/package.json)", () => {
    // Bug real: o extrator descartava a "/" inicial de um caminho absoluto,
    // virando "app/package.json" — um caminho RELATIVO ao cwd do processo,
    // não ao diretório real "/app" pedido. `resolve()` do Node resolve
    // caminho relativo a partir do cwd, então isso procurava um arquivo em
    // outro lugar completamente diferente do pedido.
    const desc = "Executar filesystem.read somente no arquivo /app/package.json";
    expect(deriveFileRead(desc)).toEqual({ path: "/app/package.json" });
  });

  it("não trunca um caminho relativo com barra interna (src/server.ts)", () => {
    // Regressão do fix acima: o padrão de caminho absoluto não pode casar
    // com a barra INTERNA de um caminho relativo — "src/server.ts" virava
    // "/server.ts" (perdia o "src"), tratado como se fosse absoluto.
    const desc = "Leia src/server.ts e não altere nenhum arquivo.";
    expect(deriveFileRead(desc)).toEqual({ path: "src/server.ts" });
  });
});
