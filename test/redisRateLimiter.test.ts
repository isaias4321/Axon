import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { RedisRateLimiter } from "../src/lib/redisRateLimiter.js";

const REDIS_URL = process.env["REDIS_URL"] ?? "redis://127.0.0.1:6379";

describe("RedisRateLimiter", () => {
  let redis: Redis;
  const prefix = `test:ratelimit:${Date.now()}:`;

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

  it("permite requisições até a capacidade máxima do balde", async () => {
    const limiter = new RedisRateLimiter(redis, 3, 60_000, prefix);

    expect((await limiter.tryConsume("chave-a")).allowed).toBe(true);
    expect((await limiter.tryConsume("chave-a")).allowed).toBe(true);
    expect((await limiter.tryConsume("chave-a")).allowed).toBe(true);
  });

  it("bloqueia a requisição que excede a capacidade", async () => {
    const limiter = new RedisRateLimiter(redis, 2, 60_000, prefix);

    await limiter.tryConsume("chave-a");
    await limiter.tryConsume("chave-a");
    const result = await limiter.tryConsume("chave-a");

    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it("trata cada chave de API de forma independente", async () => {
    const limiter = new RedisRateLimiter(redis, 1, 60_000, prefix);

    expect((await limiter.tryConsume("chave-a")).allowed).toBe(true);
    expect((await limiter.tryConsume("chave-b")).allowed).toBe(true);
    expect((await limiter.tryConsume("chave-a")).allowed).toBe(false);
  });

  it("reabastece tokens ao longo do tempo", async () => {
    const limiter = new RedisRateLimiter(redis, 1, 300, prefix); // 1 token a cada 300ms

    expect((await limiter.tryConsume("chave-a")).allowed).toBe(true);
    expect((await limiter.tryConsume("chave-a")).allowed).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 350));

    expect((await limiter.tryConsume("chave-a")).allowed).toBe(true);
  }, 2000);

  it("reset() limpa o estado de uma chave específica", async () => {
    const limiter = new RedisRateLimiter(redis, 1, 60_000, prefix);

    await limiter.tryConsume("chave-a");
    expect((await limiter.tryConsume("chave-a")).allowed).toBe(false);

    await limiter.reset("chave-a");
    expect((await limiter.tryConsume("chave-a")).allowed).toBe(true);
  });

  it("é atômico sob concorrência: N réplicas disputando o mesmo balde nunca deixam passar mais que a capacidade", async () => {
    const capacity = 5;
    const limiter = new RedisRateLimiter(redis, capacity, 60_000, prefix);

    // Simula 20 requisições concorrentes (como se viessem de várias réplicas
    // do gateway ao mesmo tempo) disputando um balde com capacidade para 5.
    const attempts = await Promise.all(
      Array.from({ length: 20 }, () => limiter.tryConsume("chave-concorrente"))
    );

    const allowedCount = attempts.filter((a) => a.allowed).length;
    expect(allowedCount).toBe(capacity);
  });
});
