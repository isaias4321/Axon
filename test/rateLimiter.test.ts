import { beforeEach, describe, expect, it, vi } from "vitest";
import { TokenBucketRateLimiter } from "../src/lib/rateLimiter.js";

describe("TokenBucketRateLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("permite requisições até a capacidade máxima do balde", () => {
    const limiter = new TokenBucketRateLimiter(3, 60_000);

    expect(limiter.tryConsume("chave-a").allowed).toBe(true);
    expect(limiter.tryConsume("chave-a").allowed).toBe(true);
    expect(limiter.tryConsume("chave-a").allowed).toBe(true);
  });

  it("bloqueia a requisição que excede a capacidade", () => {
    const limiter = new TokenBucketRateLimiter(2, 60_000);

    limiter.tryConsume("chave-a");
    limiter.tryConsume("chave-a");
    const result = limiter.tryConsume("chave-a");

    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it("trata cada chave de API de forma independente", () => {
    const limiter = new TokenBucketRateLimiter(1, 60_000);

    expect(limiter.tryConsume("chave-a").allowed).toBe(true);
    expect(limiter.tryConsume("chave-b").allowed).toBe(true);
    expect(limiter.tryConsume("chave-a").allowed).toBe(false);
  });

  it("reabastece tokens ao longo do tempo", () => {
    const limiter = new TokenBucketRateLimiter(1, 10_000); // 1 token a cada 10s

    expect(limiter.tryConsume("chave-a").allowed).toBe(true);
    expect(limiter.tryConsume("chave-a").allowed).toBe(false);

    vi.advanceTimersByTime(10_000);

    expect(limiter.tryConsume("chave-a").allowed).toBe(true);
  });

  it("reset() limpa o estado de uma chave específica", () => {
    const limiter = new TokenBucketRateLimiter(1, 60_000);

    limiter.tryConsume("chave-a");
    expect(limiter.tryConsume("chave-a").allowed).toBe(false);

    limiter.reset("chave-a");
    expect(limiter.tryConsume("chave-a").allowed).toBe(true);
  });
});
