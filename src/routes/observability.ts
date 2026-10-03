import type { FastifyPluginAsync } from "fastify";
import {
  episodesRepo,
  skillsRepo,
  reflectionsRepo,
  strategyScoresRepo,
  curiositySignalsRepo,
  goalsRepo,
  metabolismRepo,
} from "../lib/db/index.js";

/**
 * Fase 8 — Observabilidade.
 *
 * Expõe via HTTP os dados de evolução persistidos no SQLite (antes write-only):
 * - GET /v1/observability/episodes/:sessionId — episódios de uma sessão
 * - GET /v1/observability/skills/:sessionId — skills aprendidas
 * - GET /v1/observability/reflections/:sessionId — reflexões/lições
 * - GET /v1/observability/strategy-scores/:sessionId — scores de estratégias
 * - GET /v1/observability/curiosity/:sessionId — sinais de curiosidade
 * - GET /v1/observability/goals/:sessionId — objetivos gerados
 * - GET /v1/observability/metabolism/:sessionId — snapshots de energia
 * - GET /v1/observability/summary/:sessionId — resumo agregado
 *
 * Valores sanitizados: campos de conteúdo grande são truncados para consumo
 * humano. Auth por API key já aplicada globalmente.
 */

const TRUNCATE = 500;

function truncate(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.length > TRUNCATE ? `${value.substring(0, TRUNCATE)}…[truncado]` : value;
}

const observabilityRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    "/v1/observability/episodes/:sessionId",
    {
      schema: {
        description: "Lista episódios de uma sessão.",
        tags: ["observability"],
        params: { type: "object", properties: { sessionId: { type: "string" } } },
      },
    },
    async (request) => {
      const { sessionId } = request.params as { sessionId: string };
      const episodes = episodesRepo.getBySession(sessionId, 50);
      return {
        sessionId,
        episodes: episodes.map((e) => ({
          id: e.id,
          task: truncate(e.task),
          strategy: e.strategy,
          final_status: e.final_status,
          total_iterations: e.total_iterations,
          total_cost_usd: e.total_cost_usd,
          total_duration_ms: e.total_duration_ms,
        })),
      };
    }
  );

  fastify.get(
    "/v1/observability/skills/:sessionId",
    {
      schema: {
        description: "Lista skills aprendidas em uma sessão.",
        tags: ["observability"],
        params: { type: "object", properties: { sessionId: { type: "string" } } },
      },
    },
    async (request) => {
      const { sessionId } = request.params as { sessionId: string };
      const rows = skillsRepo.getBySession(sessionId, 100);
      return { sessionId, skills: rows };
    }
  );

  fastify.get(
    "/v1/observability/reflections/:sessionId",
    {
      schema: {
        description: "Lista reflexões/lições de uma sessão.",
        tags: ["observability"],
        params: { type: "object", properties: { sessionId: { type: "string" } } },
      },
    },
    async (request) => {
      const { sessionId } = request.params as { sessionId: string };
      const rows = reflectionsRepo.getBySession(sessionId, 50);
      return {
        sessionId,
        reflections: rows.map((r) => ({
          id: r.id,
          task: truncate(r.task),
          plan_worked: r.plan_worked,
          failed_step: r.failed_step,
          improvement_suggestion: truncate(r.improvement_suggestion),
          missing_knowledge: r.missing_knowledge,
        })),
      };
    }
  );

  fastify.get(
    "/v1/observability/strategy-scores/:sessionId",
    {
      schema: {
        description: "Lista scores de estratégias de uma sessão.",
        tags: ["observability"],
        params: { type: "object", properties: { sessionId: { type: "string" } } },
      },
    },
    async (request) => {
      const { sessionId } = request.params as { sessionId: string };
      const rows = strategyScoresRepo.getBySessionId(sessionId, 100);
      return { sessionId, strategyScores: rows };
    }
  );

  fastify.get(
    "/v1/observability/curiosity/:sessionId",
    {
      schema: {
        description: "Lista sinais de curiosidade de uma sessão.",
        tags: ["observability"],
        params: { type: "object", properties: { sessionId: { type: "string" } } },
      },
    },
    async (request) => {
      const { sessionId } = request.params as { sessionId: string };
      const rows = curiositySignalsRepo.getBySession(sessionId, 50);
      return { sessionId, signals: rows };
    }
  );

  fastify.get(
    "/v1/observability/goals/:sessionId",
    {
      schema: {
        description: "Lista objetivos gerados em uma sessão.",
        tags: ["observability"],
        params: { type: "object", properties: { sessionId: { type: "string" } } },
      },
    },
    async (request) => {
      const { sessionId } = request.params as { sessionId: string };
      const rows = goalsRepo.getBySession(sessionId, 50);
      return { sessionId, goals: rows };
    }
  );

  fastify.get(
    "/v1/observability/metabolism/:sessionId",
    {
      schema: {
        description: "Lista snapshots de metabolismo/energia de uma sessão.",
        tags: ["observability"],
        params: { type: "object", properties: { sessionId: { type: "string" } } },
      },
    },
    async (request) => {
      const { sessionId } = request.params as { sessionId: string };
      const rows = metabolismRepo.getRecent(sessionId, 50);
      return { sessionId, snapshots: rows };
    }
  );

  fastify.get(
    "/v1/observability/summary/:sessionId",
    {
      schema: {
        description: "Resumo agregado de evolução de uma sessão.",
        tags: ["observability"],
        params: { type: "object", properties: { sessionId: { type: "string" } } },
      },
    },
    async (request) => {
      const { sessionId } = request.params as { sessionId: string };
      const skills = skillsRepo.getBySession(sessionId, 100);
      const reflections = reflectionsRepo.getBySession(sessionId, 50);
      const strategies = strategyScoresRepo.getBySessionId(sessionId, 20);
      const episodes = episodesRepo.getBySession(sessionId, 20);

      return {
        sessionId,
        summary: {
          episodes: episodes.length,
          skills: skills.length,
          reflections: reflections.length,
          strategies: strategies.length,
          avgSuccessRate: skills.length > 0
            ? skills.reduce((acc, s) => acc + (s.success_rate ?? 0), 0) / skills.length
            : 0,
          weakCapabilities: skills
            .filter((s) => (s.usage_count ?? 0) >= 3 && (s.success_rate ?? 1) < 0.5)
            .map((s) => s.name),
        },
      };
    }
  );
};

export default observabilityRoute;