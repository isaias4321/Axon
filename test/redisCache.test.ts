import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { RedisCache } from "../src/lib/redisCache.js";

// Roda contra um Redis de verdade (local no dev/sandbox, service container no CI).
// Sem isso disponível, este arquivo de teste falha explicitamente — não faz
// sentido mockar o próprio Redis quando o objetivo é validar a integração.
const REDIS_URL = process.env["REDIS_URL"] ?? "redis://127.0.0.1:6379";

describe("RedisCache", () => {
  let redis: Redis;
  const prefix = `test:cache:${Date.now()}:`;

  beforeAll(() => {
    redis = new Redis(REDIS_URL);
  });

  afterEach(async () => {
    const keys = await redis.keys(`${prefix}*`);
    if (keys.length > 0) await redis.del(...keys);
  });

  afterAll(async () => {
    await redis.quit();
  });

  it("armazena e recupera um valor", async () => {
    const cache = new RedisCache<{ msg: string }>(redis, 60_000, prefix);
    await cache.set("k1", { msg: "valor" });
    expect(await cache.get("k1")).toEqual({ msg: "valor" });
  });

  it("retorna undefined para chave inexistente", async () => {
    const cache = new RedisCache<string>(redis, 60_000, prefix);
    expect(await cache.get("inexistente")).toBeUndefined();
  });

  it("expira o valor após o TTL", async () => {
    const cache = new RedisCache<string>(redis, 200, prefix);
    await cache.set("k1", "valor");
    expect(await cache.get("k1")).toBe("valor");

    await new Promise((resolve) => setTimeout(resolve, 350));

    expect(await cache.get("k1")).toBeUndefined();
  }, 2000);

  it("clear() remove apenas as chaves deste cache (prefixo isolado)", async () => {
    const cache = new RedisCache<string>(redis, 60_000, prefix);
    await cache.set("a", "1");
    await cache.set("b", "2");

    await cache.clear();

    expect(await cache.get("a")).toBeUndefined();
    expect(await cache.get("b")).toBeUndefined();
  });

  it("duas instâncias com o mesmo prefixo compartilham estado (simula múltiplas réplicas)", async () => {
    const cacheReplicaA = new RedisCache<string>(redis, 60_000, prefix);
    const cacheReplicaB = new RedisCache<string>(redis, 60_000, prefix);

    await cacheReplicaA.set("shared", "escrito-pela-replica-a");

    expect(await cacheReplicaB.get("shared")).toBe("escrito-pela-replica-a");
  });
});
