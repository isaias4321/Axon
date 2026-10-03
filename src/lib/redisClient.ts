import { Redis } from "ioredis";
import type { Logger } from "./logger.js";

/**
 * Cria um cliente Redis a partir de uma URL de conexão.
 *
 * `lazyConnect: true` evita que o processo trave na inicialização caso o
 * Redis esteja temporariamente indisponível — a conexão só é aberta na
 * primeira operação, e falhas são logadas em vez de derrubar o gateway.
 */
export function createRedisClient(url: string, logger: Logger): Redis {
  const client = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 2,
  });

  client.on("error", (err: Error) => {
    logger.error({ err }, "Erro de conexão com o Redis");
  });

  return client;
}
