export interface RateLimitResult {
  allowed: boolean;
  retryAfterMs: number;
  remaining: number;
}

/**
 * Contrato comum a qualquer implementação de rate limiter usada pelo
 * gateway. `TokenBucketRateLimiter` (em memória) e `RedisRateLimiter`
 * (distribuído) implementam esta mesma interface — as rotas dependem
 * apenas dela, nunca da classe concreta (Strategy pattern).
 */
export interface RateLimiter {
  tryConsume(key: string): RateLimitResult | Promise<RateLimitResult>;
  reset(key: string): void | Promise<void>;
}

interface Bucket {
  tokens: number;
  lastRefillAt: number;
}

/**
 * Rate limiter baseado em token bucket: cada chave de API tem um "balde"
 * com capacidade máxima. A cada requisição, um token é consumido; os
 * tokens são reabastecidos gradualmente ao longo do tempo até o limite.
 *
 * Isso permite rajadas curtas de tráfego (até a capacidade do balde) sem
 * bloquear o usuário, ao mesmo tempo em que impõe um teto médio sustentado.
 *
 * Válido para uma única instância do gateway. Para múltiplas réplicas,
 * veja `RedisRateLimiter` em `redisRateLimiter.ts`, que implementa o
 * mesmo algoritmo de forma atômica via Lua script no Redis.
 */
export class TokenBucketRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly maxTokens: number,
    private readonly refillWindowMs: number
  ) {}

  /** Retorna true se a requisição pode prosseguir, false se deve ser bloqueada. */
  tryConsume(key: string): RateLimitResult {
    const now = Date.now();
    const bucket = this.buckets.get(key) ?? { tokens: this.maxTokens, lastRefillAt: now };

    const elapsed = now - bucket.lastRefillAt;
    const refillRate = this.maxTokens / this.refillWindowMs; // tokens por ms
    const refilled = Math.min(this.maxTokens, bucket.tokens + elapsed * refillRate);

    if (refilled < 1) {
      const msUntilNextToken = (1 - refilled) / refillRate;
      this.buckets.set(key, { tokens: refilled, lastRefillAt: now });
      return { allowed: false, retryAfterMs: Math.ceil(msUntilNextToken), remaining: 0 };
    }

    const remaining = refilled - 1;
    this.buckets.set(key, { tokens: remaining, lastRefillAt: now });
    return { allowed: true, retryAfterMs: 0, remaining: Math.floor(remaining) };
  }

  reset(key: string): void {
    this.buckets.delete(key);
  }
}
