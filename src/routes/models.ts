import type { FastifyPluginAsync } from "fastify";
import { modelsByProvider } from "../adaptive/modelCatalog.js";
import type { ProviderAdapter } from "../providers/types.js";

const modelsRoute: FastifyPluginAsync<{
  providers: Map<string, ProviderAdapter>;
}> = async (fastify, options) => {
  fastify.get(
    "/v1/models",
    {
      schema: {
        tags: ["models"],
      },
    },
    async () => {
      const byProvider = modelsByProvider();
      const configured = Array.from(options.providers.keys());

      const allProviders = Array.from(byProvider.entries()).map(([provider, models]) => {
        const isConfigured = configured.includes(provider);
        return {
          provider,
          models,
          configured: isConfigured,
          status: isConfigured ? "configured" : "not_configured",
        };
      });

      return {
        providers: allProviders,
      };
    }
  );
};

export default modelsRoute;
