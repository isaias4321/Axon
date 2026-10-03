import type { FastifyPluginAsync } from "fastify";
import { modelsByProvider } from "../adaptive/modelCatalog.js";
import { checkProviderHealth } from "../providers/health.js";
import type { ProviderAdapter } from "../providers/types.js";

export interface ProviderHealthDetail {
  provider: string;
  models: string[];
  configured: boolean;
  healthy: boolean;
  status: "connected" | "error" | "not_configured";
  latencyMs: number | null;
  checkedAt: string;
  error?: string;
}

const providerHealthRoute: FastifyPluginAsync<{
  providers: Map<string, ProviderAdapter>;
}> = async (fastify, { providers }) => {
  fastify.get(
    "/v1/providers/health",
    {
      schema: {
        tags: ["providers"],
        summary:
          "Verifica a conexão real de cada provedor configurado (health-check/Test connection)",
        response: {
          200: {
            type: "object",
            properties: {
              providers: {
                type: "array",
                items: { type: "object", additionalProperties: true },
              },
              checkedAt: { type: "string" },
            },
          },
        },
      },
    },

    async (request) => {
      const onlyProvider = (request.query as { provider?: string })?.provider?.trim() ?? "";
      const byProvider = modelsByProvider();
      const reports: ProviderHealthDetail[] = [];

      for (const [name, models] of byProvider.entries()) {
        if (onlyProvider && name !== onlyProvider) {
          continue;
        }
        const adapter = providers.get(name);
        if (!adapter) {
          reports.push({
            provider: name,
            models,
            configured: false,
            healthy: false,
            status: "not_configured",
            latencyMs: null,
            checkedAt: new Date().toISOString(),
          });
          continue;
        }

        let report;
        try {
          report = await checkProviderHealth(adapter);
        } catch (err) {
          report = {
            provider: name,
            healthy: false,
            latencyMs: null,
            error: err instanceof Error ? err.message : String(err),
            checkedAt: new Date().toISOString(),
          };
        }

        reports.push({
          provider: name,
          models,
          configured: true,
          healthy: report.healthy,
          status: report.healthy ? "connected" : "error",
          latencyMs: report.latencyMs,
          checkedAt: report.checkedAt,
          error: report.error,
        });
      }

      return { providers: reports, checkedAt: new Date().toISOString() };
    }
  );

  // Individual provider test endpoint
  fastify.post(
    "/v1/providers/:name/test",
    {
      schema: {
        tags: ["providers"],
        summary: "Testa a conexão de um provedor específico",
        params: {
          type: "object",
          properties: {
            name: { type: "string" },
          },
          required: ["name"],
        },
        response: {
          200: {
            type: "object",
            properties: {
              provider: { type: "string" },
              models: { type: "array", items: { type: "string" } },
              healthy: { type: "boolean" },
              latencyMs: { type: ["number", "null"] },
              error: { type: ["string", "null"] },
              checkedAt: { type: "string" },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const name = (request.params as { name: string }).name;
      const byProvider = modelsByProvider();
      const models = byProvider.get(name) ?? [];
      const adapter = providers.get(name);

      if (!adapter) {
        return {
          provider: name,
          models,
          healthy: false,
          latencyMs: null,
          error: "Provider not configured",
          checkedAt: new Date().toISOString(),
        };
      }

      let report;
      try {
        report = await checkProviderHealth(adapter);
      } catch (err) {
        report = {
          provider: name,
          healthy: false,
          latencyMs: null,
          error: err instanceof Error ? err.message : String(err),
          checkedAt: new Date().toISOString(),
        };
      }

      return {
        provider: name,
        models,
        healthy: report.healthy,
        latencyMs: report.latencyMs,
        error: report.error ?? null,
        checkedAt: report.checkedAt,
      };
    }
  );
};

export default providerHealthRoute;