/**
 * Fase 9 — Cognitive Route.
 *
 * `POST /v1/cognitive` — expõe o CognitiveRouter via HTTP.
 * Recebe uma tarefa e usa as Cognitive Cells para processá-la.
 *
 * Se a tarefa não requer cells (intent genérica), retorna routerUsed=false
 * e o caller pode fallback para /v1/run.
 */

import type { FastifyPluginAsync } from "fastify";
import {
  routeWithCognitiveSystem,
  healthCheckCognitiveSystem,
  toSerializableCognitiveResult,
} from "../cognitive/index.js";
import { z } from "zod";

const cognitiveRequestSchema = z.object({
  task: z.string().min(1).max(4000),
  sessionId: z.string().optional(),
  forceRouter: z.boolean().optional().default(false),
  budgets: z
    .object({
      maxTokens: z.number().optional(),
      maxDurationMs: z.number().optional(),
      maxToolCalls: z.number().optional(),
      maxCostUsd: z.number().optional(),
    })
    .optional(),
});

const cognitiveRoute: FastifyPluginAsync = async (fastify) => {
  // POST /v1/cognitive — roteia uma tarefa via Cognitive Router
  fastify.post(
    "/v1/cognitive",
    {
      schema: {
        tags: ["cognitive"],
        summary: "Roteia uma tarefa via Cognitive Cells",
        body: {
          type: "object",
          required: ["task"],
          properties: {
            task: { type: "string", minLength: 1, maxLength: 4000 },
            sessionId: { type: "string" },
            forceRouter: { type: "boolean" },
            budgets: {
              type: "object",
              properties: {
                maxTokens: { type: "number" },
                maxDurationMs: { type: "number" },
                maxToolCalls: { type: "number" },
                maxCostUsd: { type: "number" },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const parsed = cognitiveRequestSchema.safeParse(request.body);

      if (!parsed.success) {
        return reply.code(400).send({
          error: "invalid_request",
          message: "Corpo da requisição inválido.",
          details: parsed.error.flatten().fieldErrors,
        });
      }

      const { task, sessionId, forceRouter, budgets } = parsed.data;
      const resolvedSessionId = sessionId ?? request.apiKey ?? "default";

      try {
        const result = await routeWithCognitiveSystem(task, {
          capabilities: ["raciocinio" as const],
          category: "geral",
          complexity: "media",
          text: task,
          hints: [],
          wordCount: task.split(/\s+/).length,
          charCount: task.length,
        }, resolvedSessionId, {
          forceRouter,
          budgets,
        });

        return reply.send(toSerializableCognitiveResult(result));
      } catch (error) {
        request.log.error(
          { err: error },
          "Erro ao executar Cognitive Router"
        );
        return reply.code(500).send({
          error: "internal_error",
          message: "Erro interno no Cognitive Router.",
        });
      }
    }
  );

  // GET /v1/cognitive/health — health check das células
  fastify.get(
    "/v1/cognitive/health",
    {
      schema: {
        tags: ["cognitive"],
        summary: "Health check do sistema de Cognitive Cells",
      },
    },
    async () => {
      return healthCheckCognitiveSystem();
    }
  );
};

export default cognitiveRoute;