import { ProviderHttpError, withRetry } from "../lib/retry.js";
import { getDefaultLogger } from "../lib/logger.js";
import type { Logger } from "../lib/logger.js";
import type { ChatCompletionRequest } from "../schemas/chat.js";
import type { ProviderAdapter, ProviderName } from "./types.js";

interface OpenAiCompatibleResponse {
  id: string;
  model: string;
  choices: Array<{ message: { content: string }; finish_reason?: string | null }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export interface OpenAiCompatibleOptions {
  /** Nome do provedor, usado no campo `provider` da resposta e nas mensagens de erro. */
  name: ProviderName;
  /** URL base da API (sem `/chat/completions` no final). */
  baseUrl: string;
  apiKey: string;
  /** Tempo máximo em ms para esperar resposta do provedor (padrão: 15s). */
  requestTimeoutMs?: number;
  /** Logger oficial do sistema (pino). Default: logger padrão; nunca usa console. */
  logger?: Logger;
}

/**
 * Cria um adapter para qualquer provedor de LLM que exponha um endpoint
 * `/chat/completions` no mesmo formato da OpenAI — o que hoje inclui, além
 * da própria OpenAI, o Google Gemini e o Groq (ambos oferecem uma camada
 * de compatibilidade com esse formato, especificamente para facilitar
 * migração de projetos que já usam a SDK da OpenAI).
 *
 * Isso evita reescrever a mesma lógica de request/response três vezes: a
 * única coisa que muda de fato entre OpenAI, Gemini e Groq é a URL base e
 * a chave de API — o formato da mensagem, da resposta e do streaming SSE
 * é idêntico nos três. A Anthropic é a exceção (formato próprio de
 * request/response), por isso continua com seu adapter dedicado.
 */
export function createOpenAiCompatibleAdapter(options: OpenAiCompatibleOptions): ProviderAdapter {
  const { name, baseUrl, apiKey, logger } = options;
  // BUG CORRIGIDO: `requestTimeoutMs` estava documentado ("padrão: 15s") e
  // era recebido de `options`, mas nunca chegava a ser lido — o código
  // sempre caía no default hardcoded de `callApi` (300_000ms = 5 minutos).
  // Numa arquitetura que já existe especificamente para fazer fallback
  // RÁPIDO entre provedores, esperar até 5 minutos por uma única chamada
  // que trava (sem nem retornar erro) anula o propósito do fallback — foi
  // o que aconteceu no teste de regressão (Gemini "pendurado" por ~346s
  // antes de finalmente falhar com 503).
  const defaultTimeoutMs = options.requestTimeoutMs ?? 30_000;
  const log = logger ?? getDefaultLogger();

  async function callApi(request: ChatCompletionRequest, stream: boolean, signal?: AbortSignal, timeoutMs = defaultTimeoutMs): Promise<Response> {
    // Cria um AbortController para o timeout local
    const timeoutAbort = new AbortController();
    const timeoutTimer = setTimeout(() => timeoutAbort.abort(), timeoutMs);

    // Combina o signal externo (se houver) com o timeout local
    let combinedSignal: AbortSignal;
    if (signal) {
      combinedSignal = AbortSignal.any([signal, timeoutAbort.signal]);
    } else {
      combinedSignal = timeoutAbort.signal;
    }

    try {
      const payload: Record<string, unknown> = {
        model: request.model,
        messages: request.messages,
        temperature: request.temperature,
        max_tokens: request.max_tokens,
        stream,
      };
      // `tool_choice: "none"` quebra modelos open-weight na Groq
      // (gpt-oss-120b responde 400 "Tool choice is none, but model called a
      // tool"). Como o Axon NUNCA envia `tools` (execução exclusiva via
      // ToolRegistry), omitir o campo é equivalente e evita o 400 — exceto
      // para a OpenAI, que usa o campo para reforçar o bloqueio.
      //
      // BUG CORRIGIDO: a condição antiga era
      // `name === "openai" || request.tool_choice === "none"` — como
      // `executor.ts` seta `tool_choice: "none"` em TODA chamada de etapa
      // (é a política padrão do Axon, não uma exceção pontual), o `||`
      // fazia essa condição ser SEMPRE verdadeira e reenviava o campo pra
      // Groq/Gemini em toda chamada — exatamente o cenário que o comentário
      // acima diz que devia ser evitado. Isso causava 400 recorrente no
      // Groq em QUALQUER etapa (não só filesystem), disparando fallback
      // para outro provedor a cada chamada — inclusive nas etapas finais de
      // CRITIC/SUPERVISOR, onde o modelo que acabava respondendo (depois de
      // múltiplos fallbacks) recebia um histórico de erros em vez do
      // contexto real, produzindo relatórios finais sem relação com as
      // evidências verdadeiras. Agora só a OpenAI recebe o campo.
      if (name === "openai") {
        payload.tool_choice = "none";
      }
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(payload),
        signal: combinedSignal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        // Tratamento especial: erros 503 (UNAVAILABLE) e 502 (BAD_GATEWAY)
        // são considerados transitórios e devem disparar fallback/retries
        const isTransientError = response.status === 503 || response.status === 502;
        const retryAfter = response.headers.get("retry-after");
        throw new ProviderHttpError(
          `${name} respondeu ${response.status}: ${body}`,
          response.status,
          isTransientError,
          parseRetryAfterMs(retryAfter)
        );
      }

      return response;
    } finally {
      clearTimeout(timeoutTimer);
    }
  }

  return {
    name,

    async complete(request, signal?: AbortSignal, timeoutMs?: number) {
      const startMs = performance.now();
      log.info({ provider: name, model: request.model }, "Enviando requisição ao provedor");

      let response: Response;
      try {
        response = await withRetry(() => callApi(request, false, signal, timeoutMs ?? defaultTimeoutMs));
      } catch (error) {
        const endMs = performance.now();
        const durationMs = Math.round(endMs - startMs);

        log.error(
          { err: error, provider: name, durationMs },
          "Erro/timeout no provedor durante a requisição"
        );

        throw error;
      }

      const endMs = performance.now();
      const durationMs = Math.round(endMs - startMs);

      log.info({ provider: name, durationMs }, "Resposta recebida do provedor");

      const data = (await response.json()) as OpenAiCompatibleResponse;

      return {
        id: data.id,
        provider: name,
        model: data.model,
        content: data.choices?.[0]?.message?.content ?? "",
        usage: data.usage
          ? {
              prompt_tokens: data.usage.prompt_tokens,
              completion_tokens: data.usage.completion_tokens,
              total_tokens: data.usage.total_tokens,
            }
          : undefined,
        cached: false,
        // Antes descartado — sem isso, uma resposta cortada por max_tokens
        // (finish_reason="length") era indistinguível de uma resposta
        // completa em qualquer lugar do pipeline.
        finishReason: data.choices?.[0]?.finish_reason ?? null,
      };
    },

    async stream(request) {
      const response = await withRetry(() => callApi(request, true));
      if (!response.body) {
        throw new Error(`A resposta do provedor '${name}' não retornou um corpo em stream.`);
      }
      // O formato SSE (`data: {...}\n\n`) é o mesmo nos três provedores,
      // então repassamos o stream bruto sem reprocessar.
      return response.body;
    },

    // Fase 2: health-check. `GET /models` — leve, com o mesmo header de auth.
    // Lança se o provedor estiver fora do ar ou rejeitar a chave; o report é
    // montado por `checkProviderHealth` (mede latência, captura o erro).
    async health(timeoutMs) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs ?? 5_000);

      try {
        const response = await fetch(`${baseUrl}/models`, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${apiKey}`,
          },
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new ProviderHttpError(
            `${name} health-check respondeu ${response.status}`,
            response.status
          );
        }
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? undefined : Math.max(0, timestamp - Date.now());
}
