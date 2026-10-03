import cors from "@fastify/cors";
import formbody from "@fastify/formbody";
import multipart from "@fastify/multipart";
import staticFiles from "@fastify/static";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
} from "fastify";
import { join } from "node:path";

import type { Env } from "./config.js";
import { initializeDatabase } from "./lib/db/index.js";
import { TtlCache, type CacheStore } from "./lib/cache.js";
import type { Logger } from "./lib/logger.js";
import {
  TokenBucketRateLimiter,
  type RateLimiter,
} from "./lib/rateLimiter.js";
import { RedisCache } from "./lib/redisCache.js";
import { createRedisClient } from "./lib/redisClient.js";
import { RedisRateLimiter } from "./lib/redisRateLimiter.js";
import authPlugin from "./plugins/auth.js";
import {
  filterHealthyProviders,
  type HealthChecker,
} from "./providers/health.js";
import { buildProviderRegistry } from "./providers/registry.js";
import type { ChatCompletionResponse } from "./schemas/chat.js";

import chatRoute from "./routes/chat.js";
import cognitiveRoute from "./routes/cognitive.js";
import decideRoute from "./routes/decide.js";
import healthRoute from "./routes/health.js";
import modelsRoute from "./routes/models.js";
import observabilityRoute from "./routes/observability.js";
import providerHealthRoute from "./routes/providerHealth.js";
import runRoute from "./routes/run.js";
import { SqliteSessionStore } from "./adaptive/memory.js";
import filesRoute from "./routes/files.js";

export async function buildApp(
  env: Env,
  logger: Logger
): Promise<FastifyInstance> {
  // Fase 8 — garante que as tabelas SQLite (incluindo as da F7/observabilidade)
  // existam ANTES de qualquer rota consultar o banco. Fail-open: se falhar,
  // as rotas que precisam do DB retornam erro, mas o servidor sobe.
  try {
    initializeDatabase();
  } catch (error) {
    logger.warn({ err: error }, "Falha ao inicializar o banco SQLite no boot");
  }

  // bodyLimit também é usado por @fastify/multipart como fallback do limite
  // de tamanho de arquivo quando `limits.fileSize` não é passado — por isso
  // sobe junto com MAX_UPLOAD_SIZE_MB (o default do Fastify é 1 MiB, pequeno
  // demais para anexos reais como .rar/.pdf/fotos).
  const maxUploadBytes = env.MAX_UPLOAD_SIZE_MB * 1024 * 1024;

  const fastify = Fastify({
    loggerInstance: logger as unknown as FastifyBaseLogger,
    bodyLimit: maxUploadBytes,
  });

  await fastify.register(cors, { origin: true });

  await fastify.register(formbody);
  await fastify.register(multipart, {
    limits: { fileSize: maxUploadBytes },
  });

  await fastify.register(swagger, {
    openapi: {
      info: {
        title: "Axon",
        description: "AI Agent Runtime com Cognitive Cells — gateway unificado de LLMs, agente autônomo com self-evolution e roteamento cognitivo determinístico.",
        version: "1.0.0",
      },

      components: {
        securitySchemes: {
          apiKeyAuth: {
            type: "apiKey",
            in: "header",
            name: "x-api-key",
          },
        },
      },

      security: [
        {
          apiKeyAuth: [],
        },
      ],
    },
  });

  await fastify.register(swaggerUi, {
    routePrefix: "/docs",
  });

  // Interface web de chat com o agente — arquivos estáticos servidos na raiz.
  // Fica pública (sem x-api-key): é o próprio front-end quem pede a chave ao
  // usuário e a envia manualmente em cada chamada à API a partir do navegador.
  await fastify.register(staticFiles, {
    root: join(process.cwd(), "public"),
    prefix: "/",
  });

  await fastify.register(authPlugin, {
    validKeys: env.GATEWAY_API_KEYS,
  });

  const providers = buildProviderRegistry(env);

  let rateLimiter: RateLimiter;
  let cache: CacheStore<ChatCompletionResponse>;

  if (env.REDIS_URL) {
    // Fase de resiliência — fallback automático no boot: se o Redis estiver
    // configurado mas INACESSÍVEL, caímos para as implementações em memória
    // em vez de deixar /v1/chat/completions retornar 500 em cada request.
    const redis = createRedisClient(env.REDIS_URL, logger);

    let redisOk = false;
    try {
      await redis.connect();
      redisOk = (await redis.ping()) === "PONG";
    } catch (err) {
      logger.warn(
        { err },
        "Redis configurado mas inacessível no boot — usando cache e rate limiting em memória (fail-open)"
      );
    }

    if (redisOk) {
      rateLimiter = new RedisRateLimiter(
        redis,
        env.RATE_LIMIT_MAX_REQUESTS,
        env.RATE_LIMIT_WINDOW_MS
      );

      cache = new RedisCache<ChatCompletionResponse>(
        redis,
        env.CACHE_TTL_MS
      );

      logger.info(
        { backend: "redis" },
        "Cache e rate limiting distribuídos via Redis"
      );
    } else {
      try {
        redis.disconnect();
      } catch {
        // cliente já encerrado/sem conexão — nada a fazer
      }

      rateLimiter = new TokenBucketRateLimiter(
        env.RATE_LIMIT_MAX_REQUESTS,
        env.RATE_LIMIT_WINDOW_MS
      );

      cache = new TtlCache<ChatCompletionResponse>(
        env.CACHE_TTL_MS,
        env.CACHE_MAX_ENTRIES
      );

      logger.warn(
        { backend: "memory" },
        "Fallback para memória ativo: REDIS_URL definido, porém Redis não respondeu ao ping"
      );
    }
  } else {
    rateLimiter = new TokenBucketRateLimiter(
      env.RATE_LIMIT_MAX_REQUESTS,
      env.RATE_LIMIT_WINDOW_MS
    );

    cache = new TtlCache<ChatCompletionResponse>(
      env.CACHE_TTL_MS,
      env.CACHE_MAX_ENTRIES
    );

    logger.info(
      { backend: "memory" },
      "Cache e rate limiting em memória (defina REDIS_URL para modo distribuído)"
    );
  }

  await fastify.register(healthRoute);
  await fastify.register(modelsRoute, { providers });
  await fastify.register(chatRoute, {
    providers,
    rateLimiter,
    cache,
  });

  // Fase 2: health-check opt-in. OFF por padrão (HEALTH_CHECK_ENABLED=false)
  // preserva o comportamento e os testes 100% offline; quando ligado, a rota
  // decide filtra provedores doentes antes de escolher o modelo.
  let healthChecker: HealthChecker | undefined;
  if (env.HEALTH_CHECK_ENABLED) {
    healthChecker = (currentProviders) =>
      filterHealthyProviders(currentProviders, {
        ttlMs: env.HEALTH_CHECK_TTL_MS,
      });
    logger.info(
      { ttlMs: env.HEALTH_CHECK_TTL_MS },
      "Health-check de provedores habilitado em /v1/decide"
    );
  }

  await fastify.register(decideRoute, { providers, healthChecker });

  // Fase 4: `/v1/run` — decide E executa. Runner e memória usam os defaults
  // (adapter.complete do provedor; memória por sessão do processo).
  await fastify.register(runRoute, {
    providers,
    healthChecker,
    runTimeoutMs: env.RUN_TIMEOUT_MS,
    // CRÍTICO: sem isso, `sessionStore` fica `undefined` dentro da rota e
    // TODA a memória de sessão (histórico de mensagens + contexto de
    // artefatos) nunca roda, mesmo com toda a lógica correta em
    // runtime.ts/artifacts.ts — foi exatamente isso que causava o agente
    // "esquecer" arquivos/projetos mencionados poucas mensagens antes.
    // Persistido no SQLite (não em RAM) para sobreviver a um restart do
    // processo/container.
    sessionStore: new SqliteSessionStore(),
  });

  // Fase 8 — Observabilidade
  await fastify.register(observabilityRoute);
  await fastify.register(providerHealthRoute, { providers });

  // Fase 9 — Cognitive Cells
  await fastify.register(cognitiveRoute);

  // Rota de Gerenciamento e Download de Arquivos
  await fastify.register(filesRoute);

  return fastify;
}

