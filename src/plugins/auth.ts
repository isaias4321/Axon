import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";

declare module "fastify" {
  interface FastifyRequest {
    apiKey: string;
  }
}

interface AuthPluginOptions {
  validKeys: string[];
}

const authPlugin: FastifyPluginAsync<AuthPluginOptions> = async (fastify, options) => {
  const validKeys = new Set(options.validKeys);

  fastify.decorateRequest("apiKey", "");

  fastify.addHook("onRequest", async (request, reply) => {
    // Só a API (/v1/*) exige x-api-key. /health, /docs e a interface web
    // (arquivos estáticos servidos na raiz) ficam públicos — o front-end
    // pede a chave ao usuário e a envia manualmente em cada chamada à API
    // feita a partir do navegador.
    if (!request.url.startsWith("/v1/")) {
      return;
    }

    // GET /v1/files/download fica público, assim como a UI web: o link
    // precisa funcionar numa navegação simples do navegador (clique em
    // link, atributo <a download>, <img src> para preview inline de
    // imagens geradas) — nenhum desses envia headers customizados como
    // x-api-key. A segurança continua garantida pela própria rota, que
    // resolve o caminho com `resolveSafePath` restrito à raiz do
    // workspace (mesmo modelo de ameaça de servir arquivos estáticos).
    if (request.method === "GET" && request.url.startsWith("/v1/files/download")) {
      return;
    }

    const apiKey = request.headers["x-api-key"];

    if (typeof apiKey !== "string" || !validKeys.has(apiKey)) {
      return reply.code(401).send({
        error: "unauthorized",
        message: "Chave de API ausente ou inválida. Envie o header 'x-api-key'.",
      });
    }

    request.apiKey = apiKey;
  });
};

export default fp(authPlugin, { name: "auth-plugin" });
