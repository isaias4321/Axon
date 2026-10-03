/**
 * Fase 3 — Token & Cost Engine.
 *
 * Estimadores de tokens PURos e determinísticos (sem IO, sem chamada de LLM).
 * Heurística pública "1 token ≈ 4 caracteres": robusta para código
 * (`const x = fn(1,2);` — onde contagem por palavras subestimaria) e para
 * idiomas sem espaço. Consistente com `TaskProfile.charCount`:
 * `estimateTextTokens(profile.text) === ceil(profile.charCount / 4)`.
 *
 * Não é faturamento real — só uma projeção plausível para o Model Router
 * e para o bloco `estimation` do `/v1/decide`.
 */

export interface ChatMessageLike {
  role: string;
  content: string;
}

export const CHARS_PER_TOKEN = 4;
/** Tokens fixos por mensagem (role + estrutura) — convenção da heurística. */
export const TOKENS_PER_MESSAGE_OVERHEAD = 4;
/** Tokens fixos de requisição (system primitives, formatação). */
export const TOKENS_PER_REQUEST_OVERHEAD = 2;

/** `max(1, ceil(text.length / CHARS_PER_TOKEN))` — nunca 0. */
export function estimateTextTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN));
}

/**
 * Estimativa de tokens de um array de mensagens.
 * `TOKENS_PER_REQUEST_OVERHEAD + Σ_msg (TOKENS_PER_MESSAGE_OVERHEAD + estimateTextTokens(msg.content))`.
 */
export function estimateMessagesTokens(
  messages: readonly ChatMessageLike[]
): number {
  const bodyTokens = messages.reduce(
    (sum, message) =>
      sum + TOKENS_PER_MESSAGE_OVERHEAD + estimateTextTokens(message.content),
    0
  );
  return TOKENS_PER_REQUEST_OVERHEAD + bodyTokens;
}
