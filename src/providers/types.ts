import type { ChatCompletionRequest, ChatCompletionResponse } from "../schemas/chat.js";

export type ProviderName = "openai" | "anthropic" | "gemini" | "groq";

export interface ProviderAdapter {
  readonly name: ProviderName;

  /** Chamada padrão, sem streaming: retorna a resposta completa de uma vez. */
  complete(request: ChatCompletionRequest, signal?: AbortSignal, timeoutMs?: number): Promise<ChatCompletionResponse>;

  /**
   * Chamada com streaming: retorna um ReadableStream de texto bruto
   * (Server-Sent Events) já pronto para ser repassado direto ao cliente.
   */
  stream(request: ChatCompletionRequest): Promise<ReadableStream<Uint8Array>>;

  /**
   * Health-check opcional (Fase 2). Ausente (ex: fakes de teste) → o provedor
   * é tratado como saudável por padrão (`checkProviderHealth`). Implementado
   * pelos adapters reais com um `GET` leve ao endpoint de modelos do provider.
   * Deve LANÇAR se o provedor estiver fora do ar / rejeitar a chave; o
   * `ProviderHealthReport` é montado por `checkProviderHealth`, que mede a
   * latência e captura o erro.
   */
  health?(timeoutMs?: number): Promise<void>;
}
