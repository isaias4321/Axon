import { afterEach, describe, expect, it, vi } from "vitest";
import { createGeminiAdapter } from "../src/providers/gemini.js";
import { createGroqAdapter } from "../src/providers/groq.js";
import { createOpenAiAdapter } from "../src/providers/openai.js";
import type { ChatCompletionRequest } from "../src/schemas/chat.js";

const sampleRequest: ChatCompletionRequest = {
  provider: "openai",
  model: "test-model",
  messages: [{ role: "user", content: "Olá!" }],
  temperature: 0.7,
  max_tokens: 1024,
  stream: false,
};

function mockFetchOnce(status: number, body: unknown) {
  return vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    })
  );
}

const sampleUpstreamResponse = {
  id: "resp-123",
  model: "test-model",
  choices: [{ message: { content: "Olá! Como posso ajudar?" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
};

describe.each([
  {
    label: "OpenAI",
    providerName: "openai",
    createAdapter: () => createOpenAiAdapter("fake-key"),
    expectedUrl: "https://api.openai.com/v1/chat/completions",
  },
  {
    label: "Gemini",
    providerName: "gemini",
    createAdapter: () => createGeminiAdapter("fake-key"),
    expectedUrl: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
  },
  {
    label: "Groq",
    providerName: "groq",
    createAdapter: () => createGroqAdapter("fake-key"),
    expectedUrl: "https://api.groq.com/openai/v1/chat/completions",
  },
])("$label adapter (via formato compatível com OpenAI)", ({ providerName, createAdapter, expectedUrl }) => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("chama a URL correta com autenticação Bearer", async () => {
    const fetchMock = mockFetchOnce(200, sampleUpstreamResponse);
    vi.stubGlobal("fetch", fetchMock);

    const adapter = createAdapter();
    await adapter.complete(sampleRequest);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(expectedUrl);
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer fake-key");
  });

  it("desabilita explicitamente tool-calling e não envia tools ao modelo", async () => {
    const fetchMock = mockFetchOnce(200, sampleUpstreamResponse);
    vi.stubGlobal("fetch", fetchMock);

    const adapter = createAdapter();
    await adapter.complete({ ...sampleRequest, tool_choice: "none" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { tool_choice?: string; tools?: unknown };
    // Só a OpenAI recebe `tool_choice` de fato — Gemini e Groq quebram (400
    // "Tool choice is none, but model called a tool") quando o campo é
    // enviado a modelos open-weight, então o adapter omite o campo para
    // eles mesmo quando o request interno pede "none" (o Axon nunca envia
    // `tools`, então omitir é equivalente e evita o erro).
    if (providerName === "openai") {
      expect(body.tool_choice).toBe("none");
    } else {
      expect(body).not.toHaveProperty("tool_choice");
    }
    expect(body).not.toHaveProperty("tools");
  });

  it("mapeia a resposta para o formato unificado do gateway, com o nome do provedor correto", async () => {
    vi.stubGlobal("fetch", mockFetchOnce(200, sampleUpstreamResponse));

    const adapter = createAdapter();
    const result = await adapter.complete(sampleRequest);

    expect(result).toEqual({
      id: "resp-123",
      provider: providerName,
      model: "test-model",
      content: "Olá! Como posso ajudar?",
      usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
      cached: false,
      finishReason: "stop",
    });
  });

  it("lança ProviderHttpError quando o provedor responde com erro", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("chave inválida", { status: 401 }))
    );

    const adapter = createAdapter();
    await expect(adapter.complete(sampleRequest)).rejects.toMatchObject({ status: 401 });
  });

  it("envia stream:true no corpo da requisição ao usar stream()", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(new ReadableStream(), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const adapter = createAdapter();
    await adapter.stream(sampleRequest);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const sentBody = JSON.parse(init.body as string) as { stream: boolean };
    expect(sentBody.stream).toBe(true);
  });
});
