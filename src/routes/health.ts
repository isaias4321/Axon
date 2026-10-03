import type { FastifyPluginAsync } from "fastify";

const healthRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    "/health",
    {
      schema: {
        description: "Verifica se o serviço está no ar.",
        tags: ["health"],
        response: {
          200: {
            type: "object",
            properties: {
              status: { type: "string" },
              timestamp: { type: "string" },
            },
          },
        },
      },
    },
    async () => ({ status: "ok", timestamp: new Date().toISOString() })
  );
};

export default healthRoute;
