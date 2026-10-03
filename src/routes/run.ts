import type { FastifyPluginAsync } from "fastify";

import type { SessionMemoryStore } from "../adaptive/memory.js";
import {
  executeTask,
  type LLMRunner,
} from "../adaptive/runtime.js";
import { routeWithCognitiveSystem, toSerializableCognitiveResult } from "../cognitive/index.js";
import type { HealthChecker } from "../providers/health.js";
import type { ProviderAdapter } from "../providers/types.js";
import { runRequestSchema } from "../schemas/run.js";
import { ProviderHttpError } from "../lib/retry.js";

// Logger configurado via Fastify no app.ts; acessível via request.log

interface RunRouteDeps {
  providers: Map<string, ProviderAdapter>;
  /** Executor injetável — default: `adapter.complete` do provedor decidido. */
  runner?: LLMRunner;
  /** Memória short-term por sessão (F4). Opcional. */
  sessionStore?: SessionMemoryStore;
  /** Fase 2 — opt-in. Quando presente, filtra provedores doentes antes de rotear. */
  healthChecker?: HealthChecker;
  /** Timeout máximo de execução em ms (default 10min — ver config.ts RUN_TIMEOUT_MS). */
  runTimeoutMs?: number;
}

/**
 * JSON Schema do corpo do /v1/run — usado SOMENTE para documentação Swagger,
 * derivado à mão para o /docs gerar um curl com payload válido (em vez de
 * `-d ''`). A validação real continua no Zod (`runRequestSchema`)
 * — este schema não valida nem duplica a lógica Zod.
 *
 * NOTA: O Fastify usa AJV em modo estrito, que não aceita a keyword `example`
 * nem `exclusiveMinimum` como booleano. Usamos apenas keywords válidas do JSON Schema.
 *
 * IMPORTANTE: SEM `required` — este schema é só documentação. O Fastify não deve
 * rejeitar antes do Zod (que devolve o formato de erro `invalid_request`).
 */
const runRequestBodySchema = {
  type: "object",
  properties: {
    task: {
      type: "string",
      minLength: 1,
      maxLength: 20000,
      description: "A tarefa em linguagem natural para executar. Exemplo: 'Exemplo de tarefa para o agente'",
    },
    sessionId: {
      type: "string",
      minLength: 1,
      description: "Memória short-term (F4): agrupa turnos por sessão",
    },
    provider: {
      type: "string",
      enum: ["openai", "anthropic", "gemini", "groq"],
      description: "Override de provedor (F1) — força o roteamento",
    },
    model: {
      type: "string",
      minLength: 1,
      description: "Override de modelo (F1) — força o modelo",
    },
    useCognitive: {
      type: "boolean",
      default: false,
      description: "Fase 9 — usa o Cognitive Router antes de executar",
    },
    stream: {
      type: "boolean",
      default: false,
      description: "Streaming de progresso via SSE (text/event-stream) — eventos 'progress' seguidos de um evento 'done' com o relatório completo",
    },
    budgets: {
      type: "object",
      properties: {
        maxIterations: {
          type: "integer",
          minimum: 1,
          description: "Máximo de iterações do loop autônomo",
        },
        maxCostUsd: {
          type: "number",
          minimum: 0,
          description: "Custo máximo em USD",
        },
        maxDurationMs: {
          type: "integer",
          minimum: 1,
          description: "Duração máxima em milissegundos",
        },
        maxToolCalls: {
          type: "integer",
          minimum: 1,
          description: "Máximo de chamadas de tools",
        },
        maxTokens: {
          type: "integer",
          minimum: 1,
          description: "Máximo de tokens totais",
        },
      },
      description: "Budgets opcionais para a execução autônoma (F6)",
    },
  },
  additionalProperties: true,
} as const;

/**
 * `POST /v1/run` — a fachada HTTP da Fase 4 (Agent Runtime).
 *
 * Recebe uma tarefa em linguagem natural e a EXECUTA de ponta a ponta:
 * decide estratégia + modelo (F1–F2), executa via o adapter do provedor e
 * devolve um relatório (`taskProfile`, `strategy`, `decision`, `execution`,
 * `estimation`/`costActual` da F3, `durationMs`).
 *
 * O runtime é FAIL-OPEN: falha de execução vira `execution.error` (status
 * 200) — só erros de PROVEDOR (ProviderHttpError) viram 502.
 *
 * ADICIONAL: Timeout global de 60s para evitar loops infinitos. Se excedido,
 * retorna HTTP 504 (Gateway Timeout) com mensagem clara.
 */
const runRoute: FastifyPluginAsync<RunRouteDeps> = async (
  fastify,
  { providers, runner, sessionStore, healthChecker, runTimeoutMs = 10 * 60_000 }
) => {
  fastify.post(
    "/v1/run",
    {
      schema: {
        tags: ["adaptive"],
        summary:
          "Decide e EXECUTA uma tarefa: estratégia + modelo + chamada real ao provedor",
        body: runRequestBodySchema,
        response: {
          200: {
            type: "object",
            description: "Relatório da execução do agente",
            additionalProperties: true,
          },
          400: {
            type: "object",
            description: "Corpo da requisição inválido",
            properties: {
              error: { type: "string" },
              message: { type: "string" },
            },
            additionalProperties: true,
          },
          429: {
            type: "object",
            description: "Rate limit do provedor upstream",
            properties: {
              error: { type: "string" },
              message: { type: "string" },
            },
            additionalProperties: true,
          },
          502: {
            type: "object",
            description: "Erro do provedor upstream",
            properties: {
              error: { type: "string" },
              message: { type: "string" },
            },
            additionalProperties: true,
          },
          503: {
            type: "object",
            description: "Provedor upstream temporariamente indisponível (transitório — vale tentar de novo)",
            properties: {
              error: { type: "string" },
              message: { type: "string" },
            },
            additionalProperties: true,
          },
          500: {
            type: "object",
            description: "Erro interno",
            properties: {
              error: { type: "string" },
              message: { type: "string" },
            },
            additionalProperties: true,
          },
          504: {
            type: "object",
            description: "Gateway Timeout — tempo limite de execução excedido",
            properties: {
              error: { type: "string" },
              message: { type: "string" },
            },
            additionalProperties: true,
          },
        },
      },
    },

    async (request, reply) => {
      request.log.debug(
        { path: request.url, method: request.method },
        "POST /v1/run request received"
      );

      const body = request.body as { task?: string } | undefined;
      request.log.debug(
        { hasTask: Boolean(body?.task) },
        "Body confirmado - validando schema e chamando executeTask"
      );

      const parsed = runRequestSchema.safeParse(request.body);

      if (!parsed.success) {
        return reply.code(400).send({
          error: "invalid_request",
          message: "Corpo da requisição inválido.",
          details: parsed.error.flatten().fieldErrors,
        });
      }

      const { task, sessionId, provider, model, useCognitive, stream } = parsed.data;

      // Fase 2: health-check opt-in — roteia só sobre provedores saudáveis.
      let decisionProviders = providers;
      if (healthChecker) {
        const result = await healthChecker(providers);
        decisionProviders = result.available;
      }

      // Memória (F4): o `sessionId` explícito vence; sem ele, deriva da chave
      // de API do cliente — continuidade por cliente e isolamento entre chaves.
      const resolvedSessionId = sessionId ?? request.apiKey;

      // Modo streaming (SSE): hijack a resposta e escreve os headers agora.
      // Cada fase real da execução vira um evento `progress`; ao final, um
      // evento `done` (ou `error`) fecha o stream — mesmo padrão de
      // text/event-stream já usado em /v1/chat/completions.
      let sendSse: ((event: string, data: unknown) => void) | null = null;
      if (stream) {
        reply.hijack();
        reply.raw.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        sendSse = (event, data) => {
          reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        };
      }

      // Fase 9 — Cognitive Router opt-in: quando habilitado, tenta rotear
      // a tarefa para células cognitivas especializadas ANTES do executor padrão.
      // Se o router decide não usar células (routerUsed=false), cai no fluxo padrão.
      if (useCognitive) {
        try {
          sendSse?.("progress", { phase: "cognitivo", detail: "Classificando intenção e roteando para Cognitive Cells…" });
          const cognitiveResult = await routeWithCognitiveSystem(
            task,
            {
              capabilities: ["raciocinio" as const],
              category: "geral",
              complexity: "media",
              text: task,
              hints: [],
              wordCount: task.split(/\s+/).length,
              charCount: task.length,
            },
            resolvedSessionId,
            {
              forceRouter: true,
              budgets: parsed.data.budgets,
            }
          );

          if (cognitiveResult.routerUsed) {
            const payload = {
              cognitive: toSerializableCognitiveResult(cognitiveResult),
              note: "Tarefa processada pelo Cognitive Router (Fase 9)",
            };
            if (sendSse) {
              sendSse("done", payload);
              reply.raw.end();
              return;
            }
            return reply.send(payload);
          }
        } catch (error) {
          // Fail-open: se o router falhar, continua no fluxo padrão
          request.log.warn(
            { err: error },
            "Cognitive Router falhou, usando fluxo padrão"
          );
        }
      }

      request.log.info(
        { providers: Array.from(decisionProviders.keys()) },
        "Iniciando executeTask com timeout total controlado pelo budget"
      );

      // A autoridade do timeout total da tarefa fica no budget do loop autônomo.
      // A rota HTTP não deve desligar uma execução legítima por um race externo
      // nem deixar uma tarefa continuar em background após o retorno. Se o
      // orçamento for excedido, o próprio autonomous reporta `stopReason: "timeout"`.
      const mergedBudgets = {
        ...(parsed.data.budgets ?? {}),
        maxDurationMs: parsed.data.budgets?.maxDurationMs ?? runTimeoutMs,
      };

      try {
        const report = await executeTask(task, decisionProviders, {
          runner,
          sessionStore,
          sessionId: resolvedSessionId,
          override: { provider, model },
          budgets: mergedBudgets,
          onProgress: sendSse ? (event) => sendSse("progress", event) : undefined,
        });

        request.log.info(
          { strategy: report.strategy, executed: report.execution.executed, stopReason: report.autonomous?.stopReason },
          "executeTask concluído dentro do timeout da rota"
        );

        if (sendSse) {
          sendSse("done", report);
          reply.raw.end();
          return;
        }
        return reply.send(report);
      } catch (error: unknown) {
        const err = error as Error;
        request.log.error(
          { err },
          "Erro na execução da tarefa /v1/run"
        );

        const timeoutMinutes = (runTimeoutMs / 60_000).toFixed(1);

        const sendErr = (status: 429 | 500 | 502 | 503 | 504, code: string, message: string) => {
          if (sendSse) {
            sendSse("error", { error: code, message });
            reply.raw.end();
            return;
          }
          return reply.code(status).send({ error: code, message });
        };

        // Se foi o timeout da rota (Promise.race), retornar 504
        if (err.message?.includes("route_timeout_exceeded")) {
          return sendErr(
            504,
            "gateway_timeout",
            `A execução da tarefa excedeu o tempo limite de ${timeoutMinutes} minutos na rota. Ajuste RUN_TIMEOUT_MS se suas tarefas rotineiramente precisam de mais tempo.`
          );
        }

        // Timeout via AbortController (agente abortou a execução no loop)
        if (err.message?.includes("Task execution timed out")) {
          request.log.error(
            { err },
            "Timeout — agente abortado durante a execução da tarefa"
          );
          return sendErr(
            504,
            "gateway_timeout",
            `A execução da tarefa excedeu o tempo limite de ${timeoutMinutes} minutos.`
          );
        }

        // Verificar se é ProviderHttpError
        if (error instanceof ProviderHttpError) {
          // 429 (rate limit do provedor) vira 429 com mensagem clara,
          // não 502 — o cliente sabe que deve aguardar antes de tentar de novo.
          if (error.status === 429) {
            return sendErr(429, "provider_rate_limited", `O provedor atingiu o limite de requisições: ${error.message}`);
          }
          // 503/502 do provedor (ex.: Gemini "model overloaded") já passou
          // pelo retry com backoff em lib/retry.ts antes de chegar aqui —
          // se ainda assim falhou, é uma indisponibilidade real e persistente
          // do provedor, não um bug do gateway. 503 (não 502): sinaliza ao
          // cliente que é transitório e vale tentar de novo, possivelmente
          // com outro provider/model.
          if (error.isTransient) {
            return sendErr(
              503,
              "provider_unavailable",
              `O provedor está temporariamente indisponível (alta demanda): ${error.message}. Tente novamente em alguns instantes ou troque de provider/model.`
            );
          }
          return sendErr(502, "provider_error", `O provedor retornou um erro: ${error.message}`);
        }

        // Verificar se é AbortError (timeout interno)
        if (err.name === "AbortError") {
          request.log.error(
            { err },
            `Timeout global de ${runTimeoutMs}ms excedido na execução da tarefa`
          );
          return sendErr(
            504,
            "gateway_timeout",
            `A execução da tarefa excedeu o tempo limite de ${timeoutMinutes} minutos. Tente novamente com uma tarefa menor ou menor complexidade, ou aumente RUN_TIMEOUT_MS.`
          );
        }

        request.log.error(
          { err },
          "Erro inesperado ao executar a tarefa"
        );

        return sendErr(500, "internal_error", "Erro interno no gateway.");
      }
    }
  );
};

export default runRoute;
