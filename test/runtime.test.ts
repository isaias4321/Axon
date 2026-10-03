import { describe, expect, it, vi, type Mock } from "vitest";

import { InMemorySessionStore } from "../src/adaptive/memory.js";
import { ProviderHttpError } from "../src/lib/retry.js";
import {
  executeTask,
  type LLMRunner,
} from "../src/adaptive/runtime.js";
import type { ChatCompletionRequest, ChatCompletionResponse } from "../src/schemas/chat.js";
import type { ProviderAdapter } from "../src/providers/types.js";

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
): { runner: LLMRunner; mock: Mock } {
  const mock = vi.fn().mockResolvedValue({
    id: "resp-1",
    provider: "gemini",
    model: "gemini-2.5-flash",
    content: "resposta fake do runtime",
    usage: {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    },
    cached: false,
    ...overrides,
  } satisfies ChatCompletionResponse);

  return {
    runner: { complete: mock as LLMRunner["complete"] },
    mock,
  };
}

describe("executeTask — single_agent (runner injetável)", () => {
  it("executa, expõe o content do runner e deriva costActual do usage real", async () => {
    const providers = buildProviders("openai", "groq");
    const { runner } = fakeRunner();

    const report = await executeTask(
      "Escreva uma função Python que valide um CPF",
      providers,
      { runner }
    );

    expect(report.taskProfile.category).toBe("codigo");
    expect(report.decision.status).toBe("ok");
    expect(report.strategy.strategy).toBe("single_agent");

    expect(report.execution.executed).toBe(true);
    expect(report.execution.strategy).toBe("single_agent");
    expect(report.execution.content).toBe("resposta fake do runtime");
    expect(report.execution.error).toBeNull();
    expect(report.execution.usage?.completion_tokens).toBe(5);

    // costActual derivado do usage real (F3)
    expect(report.costActual).not.toBeNull();
    expect(report.costActual?.inputTokens).toBe(10);
    expect(report.costActual?.outputTokens).toBe(5);
    expect(report.costActual?.totalTokens).toBe(15);
    expect(report.costActual?.costUsd).not.toBeNull();

    // estimation é a projeção (F3, só input)
    expect(report.estimation).not.toBeNull();
    expect(report.estimation?.outputTokens).toBeNull();
    expect(report.estimation?.costUsd).not.toBeNull();

    // métrica de duração presente
    expect(report.durationMs).not.toBeNull();
    expect(report.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("runner lança → executed=false com error, sem propagar exceção", async () => {
    const providers = buildProviders("openai", "groq");
    const { runner } = fakeRunner();

    const report = await executeTask("Tarefa simples para falhar", providers, {
      runner: {
        complete: vi.fn().mockRejectedValue(new Error("boom do provedor")),
      },
    });

    expect(report.execution.executed).toBe(false);
    expect(report.execution.error).toContain("boom do provedor");
    expect(report.execution.content).toBeNull();
    expect(report.execution.usage).toBeUndefined();
    expect(report.costActual).toBeNull();
    expect(report.durationMs).toBeNull();
    expect(runner).toBeDefined(); // evita lint unused
  });

  it("sem runner → usa o adapter.complete do provedor decidido", async () => {
    const providers = buildProviders("openai", "groq");
    // "Oi, tudo bem?" (conversa) → ranking elege groq/openai-gpt-oss-20b.
    const groq = providers.get("groq")!;
    (groq.complete as Mock).mockResolvedValue({
      id: "resp-2",
      provider: "groq",
      model: "openai/gpt-oss-20b",
      content: "via adapter",
      cached: false,
    } satisfies ChatCompletionResponse);

    const report = await executeTask("Oi, tudo bem?", providers);

    expect(report.decision.status).toBe("ok");
    expect(report.decision.provider).toBe("groq");
    expect(report.execution.executed).toBe(true);
    expect(report.execution.content).toBe("via adapter");
    expect((groq.complete as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it("nenhum provedor → executed=false, error é a razão da decisão", async () => {
    const report = await executeTask("Qualquer tarefa", new Map());

    expect(report.decision.status).toBe("nenhum_provedor_disponivel");
    expect(report.execution.executed).toBe(false);
    expect(report.execution.error).toContain("Nenhum provedor");
    expect(report.estimation).toBeNull();
    expect(report.costActual).toBeNull();
  });
});

describe("executeTask — fallback real sobre rankedCandidates (erro transitório)", () => {
  it("cai para o próximo candidato do ranking quando o primário retorna 503 transitório", async () => {
    const providers = buildProviders("gemini", "groq");

    const mock = vi.fn();
    // 1ª chamada (candidato primário): erro transitório real do provedor.
    mock.mockRejectedValueOnce(
      new ProviderHttpError("gemini respondeu 503: model overloaded", 503, true)
    );
    // 2ª chamada (próximo candidato do ranking): sucesso.
    mock.mockResolvedValueOnce({
      id: "resp-fallback",
      provider: "groq",
      model: "openai/gpt-oss-120b",
      content: "resposta do fallback",
      usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
      cached: false,
    } satisfies ChatCompletionResponse);

    const runner: LLMRunner = { complete: mock as LLMRunner["complete"] };

    const report = await executeTask(
      "Explique o que é recursão em uma frase",
      providers,
      { runner, override: { provider: "gemini" } }
    );

    expect(mock).toHaveBeenCalledTimes(2);
    const firstCallRequest = mock.mock.calls[0]?.[0] as ChatCompletionRequest;
    const secondCallRequest = mock.mock.calls[1]?.[0] as ChatCompletionRequest;
    // 1ª tentativa: o provider primário (forçado via override)
    expect(firstCallRequest.provider).toBe("gemini");
    // 2ª tentativa: outro modelo do MESMO provider forçado (override.provider
    // restringe o catálogo — ver modelRouter.ts — então o fallback aqui é
    // necessariamente outro modelo gemini, não outro provider)
    expect(secondCallRequest.provider).toBe("gemini");
    expect(secondCallRequest.model).not.toBe(firstCallRequest.model);

    expect(report.execution.executed).toBe(true);
    expect(report.execution.content).toBe("resposta do fallback");
    expect(report.execution.error).toBeNull();
    // `decision` reflete o que REALMENTE rodou, não a escolha original do F2
    expect(report.decision.model).not.toBeNull();
  });

  it("não usa fallback e propaga o erro quando NÃO há mais candidatos", async () => {
    const providers = buildProviders("gemini");
    const mock = vi
      .fn()
      .mockRejectedValue(
        new ProviderHttpError("gemini respondeu 503: model overloaded", 503, true)
      );
    const runner: LLMRunner = { complete: mock as LLMRunner["complete"] };

    await expect(
      executeTask("Explique o que é recursão em uma frase", providers, {
        runner,
        override: { provider: "gemini", model: "gemini-2.5-flash" },
      })
    ).rejects.toThrow(/503/);
  });

  it("usa fallback quando o modelo primário não existe mais no provedor (404 model_not_found)", async () => {
    const providers = buildProviders("groq");
    const mock = vi.fn();
    // Reproduz o bug real reportado: um modelo descontinuado no catálogo
    // (ex.: llama-3.1-8b-instant, removido pela Groq) retorna 404.
    mock.mockRejectedValueOnce(
      new ProviderHttpError(
        'groq respondeu 404: {"error":{"message":"The model `x` does not exist","code":"model_not_found"}}',
        404,
        false
      )
    );
    mock.mockResolvedValueOnce({
      id: "resp-404-fallback",
      provider: "groq",
      model: "openai/gpt-oss-120b",
      content: "resposta com o modelo substituto",
      cached: false,
    } satisfies ChatCompletionResponse);
    const runner: LLMRunner = { complete: mock as LLMRunner["complete"] };

    const report = await executeTask("Faça uma SaaS sobre culinária", providers, {
      runner,
    });

    expect(mock).toHaveBeenCalledTimes(2);
    expect(report.execution.executed).toBe(true);
    expect(report.execution.content).toBe("resposta com o modelo substituto");
  });

  it("não tenta fallback quando o modelo tenta chamar uma tool incompatível (400 tool_use_failed)", async () => {
    // Esse erro é determinístico para o contrato do Axon: o LLM não recebe
    // ferramentas e a execução real pertence ao ToolRegistry. Trocar de
    // modelo aqui apenas repete/mascara a incompatibilidade e consome TPM.
    const providers = buildProviders("groq");
    const mock = vi.fn();
    mock.mockRejectedValueOnce(
      new ProviderHttpError(
        'groq respondeu 400: {"error":{"message":"Tool choice is none, but model called a tool","type":"invalid_request_error","code":"tool_use_failed"}}',
        400,
        false
      )
    );
    const runner: LLMRunner = { complete: mock as LLMRunner["complete"] };

    await expect(
      executeTask("Explique o que é uma variável em uma frase", providers, { runner })
    ).rejects.toThrow(/tool_use_failed/);
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("faz fallback de Groq para Gemini sem repetir o provedor que tentou tool-calling", async () => {
    const providers = buildProviders("groq", "gemini");
    const mock = vi
      .fn()
      .mockRejectedValueOnce(new ProviderHttpError(
        'groq respondeu 400: {"error":{"message":"Tool choice is none, but model called a tool","code":"tool_use_failed"}}',
        400
      ))
      .mockResolvedValueOnce({
        id: "resp-gemini-fallback",
        provider: "gemini",
        model: "gemini-2.5-flash",
        content: "Resposta textual sem tool call.",
        cached: false,
      } satisfies ChatCompletionResponse);
    const runner: LLMRunner = { complete: mock as LLMRunner["complete"] };

    const report = await executeTask("Explique uma variável em uma frase", providers, { runner });

    expect(report.execution.executed).toBe(true);
    expect(report.execution.content).toBe("Resposta textual sem tool call.");
    expect(mock).toHaveBeenCalledTimes(2);
    const requests = mock.mock.calls as Array<[ChatCompletionRequest]>;
    expect(requests[1]?.[0].provider).toBe("gemini");
    expect(requests[0]?.[0].tool_choice).toBe("none");
    expect(requests[1]?.[0].tool_choice).toBe("none");
  });

  it("faz fallback quando o provedor retorna HTTP 200 sem conteúdo", async () => {
    const providers = buildProviders("groq", "gemini");
    const mock = vi
      .fn()
      .mockResolvedValueOnce({
        id: "resp-empty",
        provider: "groq",
        model: "openai/gpt-oss-120b",
        content: "",
        cached: false,
      } satisfies ChatCompletionResponse)
      .mockResolvedValueOnce({
        id: "resp-non-empty",
        provider: "gemini",
        model: "gemini-2.5-flash",
        content: "Código válido gerado pelo provedor alternativo.",
        cached: false,
      } satisfies ChatCompletionResponse);
    const runner: LLMRunner = { complete: mock as LLMRunner["complete"] };

    const report = await executeTask("Gere uma função simples", providers, { runner });

    expect(report.execution.executed).toBe(true);
    expect(report.execution.content).toContain("Código válido");
    expect(mock).toHaveBeenCalledTimes(2);
    expect((mock.mock.calls[1]?.[0] as { provider?: string } | undefined)?.provider).toBe("gemini");
  });

  it("NÃO tenta fallback para um 400 genérico (não é o quirk específico tool_use_failed)", async () => {
    const providers = buildProviders("groq", "gemini");
    const mock = vi
      .fn()
      .mockRejectedValue(
        new ProviderHttpError(
          'groq respondeu 400: {"error":{"message":"campo obrigatório ausente","code":"invalid_request"}}',
          400,
          false
        )
      );
    const runner: LLMRunner = { complete: mock as LLMRunner["complete"] };

    await expect(
      executeTask("Explique o que é recursão em uma frase", providers, { runner })
    ).rejects.toThrow(/campo obrigatório ausente/);

    // Só 1 tentativa — um 400 genérico normalmente é bug de quem chamou;
    // mascarar isso trocando de modelo só esconderia o problema real.
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("NÃO tenta fallback para um erro não-transitório (ex.: 401)", async () => {
    const providers = buildProviders("gemini", "groq");
    const mock = vi
      .fn()
      .mockRejectedValue(new ProviderHttpError("chave inválida", 401, false));
    const runner: LLMRunner = { complete: mock as LLMRunner["complete"] };

    await expect(
      executeTask("Explique o que é recursão em uma frase", providers, { runner })
    ).rejects.toThrow(/chave inválida/);

    // Só 1 tentativa — erro de config não deve "gastar" fallback tentando
    // outros provedores às cegas.
    expect(mock).toHaveBeenCalledTimes(1);
  });
});

describe("executeTask — estratégias que NÃO executam", () => {
  it("multi_agent executa o orchestrator (F5)", async () => {
    const providers = buildProviders("openai", "groq");
    const { runner } = fakeRunner();

    // F1 marca alta + capacidades → multi_agent; o runtime agora chama o
    // orchestrator, que executa agentes especializados.
    const report = await executeTask(
      "Analise o impacto e projete a arquitetura de uma migracao de monolitos para microservicos, planejando as etapas e os testes de cada fase",
      providers,
      { runner }
    );

    expect(report.strategy.strategy).toBe("multi_agent");
    expect(report.execution.executed).toBe(true);
    expect(report.execution.strategy).toBe("multi_agent");
    expect(report.execution.error).toBeNull();
    expect(report.execution.content).toBe("resposta fake do runtime");

    // Relatório de orquestração presente (Fase 5).
    expect(report.orchestration).toBeDefined();
    expect(report.orchestration?.strategy).toBe("multi_agent");
    expect((report.orchestration?.steps.length ?? 0)).toBeGreaterThanOrEqual(2);
    expect((report.orchestration?.subtasks.length ?? 0)).toBe(
      report.orchestration?.steps.length
    );
    expect(report.orchestration?.cost.totalTokens).toBeGreaterThan(0);

    // costActual derivado do usage global da síntese (não mais null).
    expect(report.costActual).not.toBeNull();
  });

  it("multi_agent com erro genérico no orchestrator → executed=false, fail-open", async () => {
    const providers = buildProviders("openai", "groq");
    const runner = { complete: vi.fn().mockRejectedValue(new Error("boom")) };

    const report = await executeTask(
      "Analise o impacto e projete a arquitetura de uma migracao de monolitos para microservicos, planejando as etapas e os testes de cada fase",
      providers,
      { runner }
    );

    expect(report.strategy.strategy).toBe("multi_agent");
    // Passos continuam fail-open; a síntese também falhou (banana/genérico) →
    // `executed=false` com error no execution, sem propagar exceção.
    expect(report.execution.executed).toBe(false);
    expect(report.execution.error).toContain("boom");
  });

  it("no_execution (1 palavra) → executed=false, error é o motivo da estratégia", async () => {
    const providers = buildProviders("openai", "groq");
    const { runner } = fakeRunner();

    const report = await executeTask("Olá", providers, { runner });

    expect(report.strategy.strategy).toBe("no_execution");
    expect(report.execution.executed).toBe(false);
    expect(report.execution.error).toContain("ambígua");
  });

  it("override válido executa mesmo quando a estratégia seria multi_agent", async () => {
    const providers = buildProviders("openai", "groq");
    const { runner } = fakeRunner();

    // override força o fluxo single_agent (removendo a estratégia multi_agent).
    // "openai" está configurado no registry, logo o override é válido.
    const report = await executeTask(
      "Analise o impacto e projete a arquitetura de uma migracao de monolitos para microservicos, planejando as etapas e os testes de cada fase",
      providers,
      { runner, override: { provider: "openai", model: "gpt-4o-mini" } }
    );

    expect(report.decision.status).toBe("ok");
    expect(report.decision.model).toBe("gpt-4o-mini");
    expect(report.execution.executed).toBe(true);
  });
});

describe("executeTask — memória short-term", () => {
  it("com sessionId + store grava turnos user e assistant", async () => {
    const store = new InMemorySessionStore();
    const providers = buildProviders("openai", "groq");
    const { runner } = fakeRunner();

    const report = await executeTask("Escreva uma função Python", providers, {
      runner,
      sessionStore: store,
      sessionId: "sessao-1",
    });

    expect(store.recall("sessao-1")).toEqual([
      { role: "user", content: "Escreva uma função Python" },
      { role: "assistant", content: "resposta fake do runtime" },
    ]);
    expect(report.execution.executed).toBe(true);
  });

  it("REGRESSÃO: grava o turno assistant na memória mesmo quando execution.executed é false, desde que haja conteúdo (fallback do loop autônomo)", async () => {
    // Antes exigia `execution.executed === true` para salvar a resposta do
    // assistente — mas o fallback do loop autônomo (no_progress) sintetiza
    // uma resposta ÚTIL mesmo quando o `stopReason` final não é "success"
    // (ver synthesizeFallbackAnswer em autonomous.ts). O usuário via essa
    // resposta na tela, mas ela nunca ficava na memória da sessão — no
    // turno seguinte o agente não lembrava de nada do que tinha acabado de
    // descobrir/responder.
    const store = new InMemorySessionStore();
    const providers = buildProviders("openai", "groq");
    const { runner } = fakeRunner(); // sempre retorna texto puro, nunca uma tool call válida

    const report = await executeTask("leia o conteudo do arquivo relatorio.zip", providers, {
      runner,
      sessionStore: store,
      sessionId: "sessao-fallback",
    });

    expect(report.execution.executed).toBe(false);
    expect(report.execution.content).toBeTruthy();

    const memory = store.recall("sessao-fallback");
    expect(memory.some((m) => m.role === "assistant" && m.content === report.execution.content)).toBe(true);
  });

  it("sem sessionId → não grava memória", async () => {
    const store = new InMemorySessionStore();
    const providers = buildProviders("openai", "groq");
    const { runner } = fakeRunner();

    await executeTask("Tarefa sem sessão", providers, {
      runner,
      sessionStore: store,
    });

    expect(store.recall("x").length).toBe(0);
  });

  it("com memoryTurn=false → não grava mesmo com sessionId", async () => {
    const store = new InMemorySessionStore();
    const providers = buildProviders("openai", "groq");
    const { runner } = fakeRunner();

    await executeTask("Tarefa sem gravar", providers, {
      runner,
      sessionStore: store,
      sessionId: "s1",
      memoryTurn: false,
    });

    expect(store.recall("s1")).toEqual([]);
  });

  it("falha de execução grava apenas o turno user", async () => {
    const store = new InMemorySessionStore();
    const providers = buildProviders("openai", "groq");

    await executeTask("Tarefa que falha", providers, {
      sessionStore: store,
      sessionId: "s1",
      runner: { complete: vi.fn().mockRejectedValue(new Error("boom")) },
    });

    expect(store.recall("s1")).toEqual([
      { role: "user", content: "Tarefa que falha" },
    ]);
  });

  it("REGRESSÃO: injeta o histórico da sessão no prompt enviado ao LLM (recall() nunca era chamado antes)", async () => {
    // Bug real relatado por um usuário: "quando mando o arquivo e peço pra
    // ele outra atividade, parece que ele esquece que já tinha esse
    // arquivo em mãos". Causa raiz: `sessionStore.recall()` nunca era
    // chamado em lugar nenhum do código — a sessão só GRAVAVA turnos,
    // nunca os LIA de volta antes de montar o prompt da próxima chamada.
    const store = new InMemorySessionStore();
    const providers = buildProviders("openai", "groq");
    const { runner, mock } = fakeRunner();

    // Primeiro turno: menciona um arquivo específico.
    await executeTask('O usuário anexou o arquivo "relatorio.zip".', providers, {
      runner,
      sessionStore: store,
      sessionId: "sessao-memoria",
    });

    mock.mockClear();

    // Segundo turno: pergunta genérica, SEM mencionar o arquivo de novo.
    // Frase escolhida para cair em "pergunta de capacidade" → estratégia
    // single_agent (uma única chamada ao LLM) — assim o teste verifica
    // apenas a injeção de histórico, sem depender de quantas chamadas o
    // loop autônomo faria para uma tool intent diferente.
    await executeTask("Pode me explicar o que é esse arquivo?", providers, {
      runner,
      sessionStore: store,
      sessionId: "sessao-memoria",
    });

    expect(mock).toHaveBeenCalledTimes(1);
    const sentRequest = mock.mock.calls[0]?.[0] as { messages: { role: string; content: string }[] };
    const sentContent = sentRequest.messages[0]?.content ?? "";

    // O prompt enviado ao LLM no segundo turno precisa conter o histórico
    // do primeiro turno (incluindo o nome do arquivo), mesmo a mensagem
    // atual não mencionando-o.
    expect(sentContent).toContain("relatorio.zip");
    expect(sentContent).toContain("Pode me explicar o que é esse arquivo?");
  });

  it("classificação (taskProfile) usa só o texto CRU da mensagem atual, não o histórico injetado", async () => {
    // O histórico só deve afetar o PROMPT do LLM — nunca a classificação
    // por regex (analyzeTask/detectToolIntent). Misturar os dois já causou
    // um bug real antes (um token de um turno anterior foi interpretado
    // como parte do pedido atual).
    const store = new InMemorySessionStore();
    const providers = buildProviders("openai", "groq");
    const { runner } = fakeRunner();

    await executeTask('Crie um arquivo chamado "relatorio.zip" para mim.', providers, {
      runner,
      sessionStore: store,
      sessionId: "sessao-classificacao",
    });

    const report = await executeTask("oi, tudo bem?", providers, {
      runner,
      sessionStore: store,
      sessionId: "sessao-classificacao",
    });

    // `taskProfile.text` reflete a mensagem atual, não o histórico.
    expect(report.taskProfile.text).toBe("oi, tudo bem?");
  });
});
