import { z } from "zod";

export const chatMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string().min(1, "O conteúdo da mensagem não pode ser vazio."),
});

export const chatCompletionRequestSchema = z.object({
  provider: z.enum(["openai", "anthropic", "gemini", "groq"]),
  model: z.string().min(1, "Informe o modelo desejado."),
  messages: z.array(chatMessageSchema).min(1, "Envie pelo menos uma mensagem."),
  temperature: z.number().min(0).max(2).default(0.7),
  max_tokens: z.number().int().positive().max(8000).default(1024),
  stream: z.boolean().default(false),
  /** O Axon executa tools via ToolRegistry; LLMs nunca recebem tools para chamar. */
  tool_choice: z.literal("none").optional(),
});

export type ChatCompletionRequest = z.infer<typeof chatCompletionRequestSchema>;
export type ChatMessage = z.infer<typeof chatMessageSchema>;

export const chatCompletionResponseSchema = z.object({
  id: z.string(),
  provider: z.enum(["openai", "anthropic", "gemini", "groq"]),
  model: z.string(),
  content: z.string(),
  usage: z
    .object({
      prompt_tokens: z.number().optional(),
      completion_tokens: z.number().optional(),
      total_tokens: z.number().optional(),
    })
    .optional(),
  cached: z.boolean().default(false),
  // Fase 3 — Token & Cost Engine: projeção estimada do request (offline).
  // Campos OPcionais: presente no fluxo não-streaming; ausente em stream/erros.
  estimatedInputTokens: z.number().optional(),
  estimatedOutputTokens: z.number().optional(),
  estimatedCostUsd: z.number().optional(),
  /**
   * Motivo de parada reportado pelo provedor (ex.: "stop", "length",
   * "content_filter"). Antes descartado silenciosamente — uma geração de
   * código cortada por `max_tokens` insuficiente (finish_reason="length")
   * era aceita como resposta completa e válida, sem nenhum sinal de que o
   * conteúdo estava truncado no meio de uma função.
   */
  finishReason: z.string().nullable().optional(),
});

export type ChatCompletionResponse = z.infer<typeof chatCompletionResponseSchema>;
