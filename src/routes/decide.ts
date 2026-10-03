import type { FastifyPluginAsync } from "fastify";

import { estimateTaskCost } from "../adaptive/costEstimator.js";
import { analyzeTask } from "../adaptive/taskAnalyzer.js";
import { decideStrategy } from "../adaptive/strategyEngine.js";
import { routeModel } from "../adaptive/modelRouter.js";
import type { HealthChecker } from "../providers/health.js";
import type { ProviderAdapter } from "../providers/types.js";
import { decideRequestSchema } from "../schemas/decide.js";

interface DecideRouteDeps {
  providers: Map<string, ProviderAdapter>;
  /** Fase 2 — opt-in. Quando presente, filtra provedores doentes antes do roteamento. */
  healthChecker?: HealthChecker;
}

/**
 * JSON Schema do corpo do /v1/decide — usado SOMENTE para documentação Swagger,
 * derivado à mão para o /docs gerar um curl com payload válido (em vez de
 * `-d ''`). A validação real continua no Zod (`decideRequestSchema`)
 * — este schema não valida nem duplica a lógica Zod.
 *
 * NOTA: O Fastify usa AJV em modo estrito, que não aceita a keyword `example`
 * nem `exclusiveMinimum` como booleano. Usamos apenas keywords válidas do JSON Schema.
 *
 * IMPORTANTE: SEM `required` — este schema é só documentação. O Fastify não deve
 * rejeitar antes do Zod (que devolve o formato de erro `invalid_request`).
 */
const decideRequestBodySchema = {
  type: "object",
  properties: {
    task: {
      type: "string",
      minLength: 1,
      maxLength: 20000,
      description: "A tarefa em linguagem natural para o motor adaptativo analisar. Exemplo: 'Exemplo de tarefa para o agente'",
    },
    provider: {
      type: "string",
      enum: ["openai", "anthropic", "gemini", "groq"],
      description: "Override de provedor — força o roteamento para um provedor específico",
    },
    model: {
      type: "string",
      minLength: 1,
      description: "Override de modelo — força o modelo específico a ser usado",
    },
  },
  additionalProperties: true,
} as const;

/**
 * `POST /v1/decide` — a fachada HTTP da Fase 1 (Adaptive Core + Model Router).
 *
 * Recebe uma tarefa em texto e devolve a DECISÃO do motor adaptativo:
 * classificação (TaskProfile), estratégia (StrategyDecision) e modelo
 * escolhido (ModelDecision) — SEM executar chamada real ao provedor.
 * O cliente interpreta `decision.status`.
 *
 * A validação é feita pelo Zod (fonte única) no handler; o schema do
 * Fastify aqui é apenas para o Swagger (com `schema.body` para o /docs
 * gerar um curl com payload válido em vez de `-d ''`).
 */
const decideRoute: FastifyPluginAsync<DecideRouteDeps> = async (
  fastify,
  { providers, healthChecker }
) => {
  fastify.post(
    "/v1/decide",
    {
      schema: {
        tags: ["adaptive"],
        summary:
          "Analisa uma tarefa e devolve a estratégia e o modelo de IA recomendados",
        body: decideRequestBodySchema,
        response: {
          200: {
            type: "object",
            description: "Decisão do motor adaptativo",
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
        },
      },
    },

    async (request, reply) => {
      const parsed = decideRequestSchema.safeParse(request.body);

      if (!parsed.success) {
        return reply.code(400).send({
          error: "invalid_request",
          message: "Corpo da requisição inválido.",
          details: parsed.error.flatten().fieldErrors,
        });
      }

      const { task, provider, model } = parsed.data;

      const profile = analyzeTask(task);
      const strategy = decideStrategy(profile);

      // Fase 2: se o health-check estiver habilitado, roteia só sobre os
      // provedores saudáveis e expõe o report na resposta.
      let decisionProviders = providers;
      let healthReports:
        | Awaited<ReturnType<NonNullable<HealthChecker>>>["reports"]
        | undefined;

      if (healthChecker) {
        const result = await healthChecker(providers);
        decisionProviders = result.available;
        healthReports = result.reports;
      }

      const decision = routeModel(profile, strategy.strategy, decisionProviders, {
        override: { provider, model },
      });

      // Fase 3 — Token & Cost Engine: projeção offline do custo do request.
      // `decision.costEstimate` é o blend usado para RANKING; `estimation.costUsd`
      // usa o preço input refinado. `null` quando não há modelo vencedor.
      const estimation = estimateTaskCost(decision.model, profile.text);

      const response: {
        taskProfile: ReturnType<typeof analyzeTask>;
        strategy: ReturnType<typeof decideStrategy>;
        decision: typeof decision;
        estimation: typeof estimation;
        health?: typeof healthReports;
      } = { taskProfile: profile, strategy, decision, estimation };

      if (healthReports) {
        response.health = healthReports;
      }

      return reply.send(response);
    }
  );
};

export default decideRoute;
