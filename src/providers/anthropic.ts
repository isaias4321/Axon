import { ProviderHttpError, withRetry } from "../lib/retry.js";
import type { ChatCompletionRequest, ChatMessage } from "../schemas/chat.js";
import type { ProviderAdapter } from "./types.js";

const ANTHROPIC_BASE_URL = process.env["ANTHROPIC_BASE_URL"] ?? "https://api.anthropic.com/v1";
const ANTHROPIC_VERSION = "2023-06-01";

interface AnthropicResponse {
  id: string;
  model: string;
  content: Array<{ type: string; text?: string }>;
  usage?: { input_tokens: number; output_tokens: number };
  stop_reason?: string | null;
}

/**
 * A API da Anthropic separa o prompt de sistema do array de mensagens
 * (diferente da OpenAI, que trata "system" como mais uma mensagem).
 * Esta função adapta o formato unificado do gateway para o formato nativo.
 */
function splitSystemPrompt(messages: ChatMessage[]): {
  system: string | undefined;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
} {
  const systemMessages = messages.filter((m) => m.role === "system");
  const conversation = messages
    .filter((m): m is ChatMessage & { role: "user" | "assistant" } => m.role !== "system")
    .map((m) => ({ role: m.role, content: m.content }));

  return {
    system: systemMessages.length > 0 ? systemMessages.map((m) => m.content).join("\n") : undefined,
    messages: conversation,
  };
}

export function createAnthropicAdapter(apiKey: string): ProviderAdapter {
  async function callApi(request: ChatCompletionRequest, stream: boolean): Promise<Response> {
    const { system, messages } = splitSystemPrompt(request.messages);

    const response = await fetch(`${ANTHROPIC_BASE_URL}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: request.model,
        system,
        messages,
        temperature: request.temperature,
        max_tokens: request.max_tokens,
        stream,
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new ProviderHttpError(`Anthropic respondeu ${response.status}: ${body}`, response.status);
    }

    return response;
  }

  return {
    name: "anthropic",

    async complete(request) {
      const response = await withRetry(() => callApi(request, false));
      const data = (await response.json()) as AnthropicResponse;

      const textBlock = data.content.find((block) => block.type === "text");

      return {
        id: data.id,
        provider: "anthropic",
        model: data.model,
        content: textBlock?.text ?? "",
        usage: data.usage
          ? {
              prompt_tokens: data.usage.input_tokens,
              completion_tokens: data.usage.output_tokens,
              total_tokens: data.usage.input_tokens + data.usage.output_tokens,
            }
          : undefined,
        cached: false,
        // "max_tokens" na Anthropic é o equivalente ao finish_reason="length"
        // da OpenAI/Groq/Gemini — normaliza pro mesmo valor pro validador não
        // precisar conhecer o vocabulário de cada provedor.
        finishReason: data.stop_reason === "max_tokens" ? "length" : (data.stop_reason ?? null),
      };
    },

    async stream(request) {
      const response = await withRetry(() => callApi(request, true));
      if (!response.body) {
        throw new Error("A resposta da Anthropic não retornou um corpo em stream.");
      }
      return response.body;
    },

    // Fase 2: health-check. `GET /v1/models` — leve, com o mesmo header de auth.
    // Lança se o provedor estiver fora do ar ou rejeitar a chave; o report é
    // montado por `checkProviderHealth` (mede latência, captura o erro).
    async health(timeoutMs) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs ?? 5_000);

      try {
        const response = await fetch(`${ANTHROPIC_BASE_URL}/models`, {
          method: "GET",
          headers: {
            "x-api-key": apiKey,
            "anthropic-version": ANTHROPIC_VERSION,
          },
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new ProviderHttpError(
            `Anthropic health-check respondeu ${response.status}`,
            response.status
          );
        }
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
