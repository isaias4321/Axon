import { z } from "zod";

/**
 * Fase 4 — Agent Runtime.
 *
 * `POST /v1/run` recebe uma tarefa em linguagem natural e a EXECUTA de
 * verdade (diferente do `/v1/decide`, que só decide): decide estratégia +
 * modelo (F1–F2), executa via o adapter do provedor e devolve um relatório
 * completo (decisão + execução + custo projetado + custo real).
 */
export const runRequestSchema = z.object({
  task: z.string().trim().min(1, "Informe a tarefa.").max(20_000),
  /** Memória short-term (F4): agrupa turnos por sessão. Opcional. */
  sessionId: z.string().min(1).optional(),
  /** Override de provedor (F1) — força o roteamento. Opcional. */
  provider: z.enum(["openai", "anthropic", "gemini", "groq"]).optional(),
  /** Override de modelo (F1) — força o modelo. Opcional. */
  model: z.string().min(1).optional(),
  /** Fase 9 — usa o Cognitive Router antes de executar. Opcional. */
  useCognitive: z.boolean().optional().default(false),
  /**
   * Streaming de progresso via SSE (text/event-stream): eventos `progress`
   * a cada fase/iteração real da execução, seguidos de um evento final
   * `done` com o AgentRunReport completo. Opcional, default false
   * (comportamento clássico: uma única resposta JSON ao final).
   */
  stream: z.boolean().optional().default(false),
  /** Budgets opcionais para a execução autônoma (F6). */
  budgets: z
    .object({
      /** Máximo de iterações do loop autônomo. */
      maxIterations: z.number().int().positive().optional(),
      /** Custo máximo em USD. */
      maxCostUsd: z.number().positive().optional(),
      /** Duração máxima em milissegundos. */
      maxDurationMs: z.number().int().positive().optional(),
      /** Máximo de chamadas de tools. */
      maxToolCalls: z.number().int().positive().optional(),
      /** Máximo de tokens totais. */
      maxTokens: z.number().int().positive().optional(),
    })
    .optional(),
});

export type RunRequest = z.infer<typeof runRequestSchema>;
