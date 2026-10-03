import type { FastifyPluginAsync } from "fastify";
import { estimateChatCost } from "../adaptive/costEstimator.js";
import { buildCacheKey, type CacheStore } from "../lib/cache.js";
import type { RateLimiter } from "../lib/rateLimiter.js";
import { ProviderHttpError } from "../lib/retry.js";
import type { ProviderAdapter } from "../providers/types.js";
import {
  chatCompletionRequestSchema,
  type ChatCompletionResponse,
} from "../schemas/chat.js";

/**
 * JSON Schema do corpo do chat — usado SOMENTE para documentação Swagger,
 * derivado à mão para o /docs gerar um curl com payload válido (em vez de
 * `-d ''`). A validação real continua no Zod (`chatCompletionRequestSchema`)
 * — este schema não valida nem duplica a lógica Zod.
 */
const chatRequestBodySchema = {
  type: "object",
  properties: {
    provider: { type: "string", enum: ["openai", "anthropic", "gemini", "groq"] },
    model: { type: "string", minLength: 1 },
    messages: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        properties: {
          role: { type: "string", enum: ["system", "user", "assistant"] },
          content: { type: "string", minLength: 1 },
        },
        required: ["role", "content"],
      },
    },
    temperature: { type: "number", minimum: 0, maximum: 2, default: 0.7 },
    max_tokens: { type: "integer", minimum: 1, maximum: 8000, default: 1024 },
    stream: { type: "boolean", default: false },
  },
  // SEM `required`: este schema é só documentação — o Fastify não deve
  // rejeitar antes do Zod (que devolve o formato de erro `invalid_request`).
  additionalProperties: true,
} as const;

interface ChatRouteDeps {
  providers: Map<string, ProviderAdapter>;
  rateLimiter: RateLimiter;
  cache: CacheStore<ChatCompletionResponse>;
}

const chatRoute: FastifyPluginAsync<ChatRouteDeps> = async (
  fastify,
  { providers, rateLimiter, cache }
) => {
  fastify.post(
    "/v1/chat/completions",
    {
      // body schema SOMENTE para o Swagger gerar um curl com payload válido.
      // A validação real fica no Zod (chatRequestBodySchema ≠ chatCompletionRequestSchema).
      schema: {
        tags: ["chat"],
        summary: "Envia uma mensagem para um provedor de IA",
        body: chatRequestBodySchema,
      },
    },

    async (request, reply) => {
      // Rate limiting por chave de API
      const limitResult = await rateLimiter.tryConsume(request.apiKey);

      reply.header(
        "x-ratelimit-remaining",
        limitResult.remaining
      );

      if (!limitResult.allowed) {
        reply.header(
          "retry-after",
          Math.ceil(limitResult.retryAfterMs / 1000)
        );

        return reply.code(429).send({
          error: "rate_limited",
          message:
            "Limite de requisições excedido. Tente novamente em instantes.",
        });
      }

      // Validação do corpo da requisição
      const parsed = chatCompletionRequestSchema.safeParse(
        request.body
      );

      if (!parsed.success) {
        return reply.code(400).send({
          error: "invalid_request",
          message: "Corpo da requisição inválido.",
          details: parsed.error.flatten().fieldErrors,
        });
      }

      const chatRequest = parsed.data;

      // Verifica se o provedor está configurado
      const adapter = providers.get(chatRequest.provider);

      if (!adapter) {
        return reply.code(503).send({
          error: "provider_unavailable",
          message: `O provedor '${chatRequest.provider}' não está configurado neste gateway.`,
        });
      }

      try {
        // Streaming
        if (chatRequest.stream) {
          const upstream = await adapter.stream(chatRequest);

          reply.hijack();

          reply.raw.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });

          for await (
            const chunk of upstream as unknown as AsyncIterable<Uint8Array>
          ) {
            reply.raw.write(chunk);
          }

          reply.raw.end();
          return;
        }

        // Cache
        const cacheKey = buildCacheKey(chatRequest);

        const cached = await cache.get(cacheKey);

        if (cached) {
          return reply.send({
            ...cached,
            cached: true,
          });
        }

        // Chamada ao provedor
        const result = await adapter.complete(chatRequest);

        // Fase 3 — Token & Cost Engine: projeta o custo do request e guarda
        // os campos estimados no cache, para o cache hit devolver os mesmos.
        const costFields = estimateChatCost(
          chatRequest.model,
          chatRequest.messages,
          result.content,
          result.usage
        );
        const estimated: ChatCompletionResponse = { ...result, ...costFields };

        await cache.set(cacheKey, estimated);

        return reply.send(estimated);
      } catch (error) {
        if (error instanceof ProviderHttpError) {
          if (error.status === 429) {
            return reply.code(429).send({
              error: "provider_rate_limited",
              message: `O provedor '${chatRequest.provider}' atingiu o limite de requisições: ${error.message}`,
            });
          }
          return reply.code(502).send({
            error: "provider_error",
            message: `O provedor '${chatRequest.provider}' retornou um erro: ${error.message}`,
          });
        }

        request.log.error(
          { err: error },
          "Erro inesperado ao chamar o provedor de IA"
        );

        return reply.code(500).send({
          error: "internal_error",
          message: "Erro interno no gateway.",
        });
      }
    }
  );
};

export default chatRoute;