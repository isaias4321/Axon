import { type Redis } from "ioredis";
import type { RateLimiter, RateLimitResult } from "./rateLimiter.js";

/**
 * Reimplementa o mesmo algoritmo de token bucket do `TokenBucketRateLimiter`,
 * mas executado inteiramente dentro do Redis via um Lua script — isso é o
 * que garante atomicidade: mesmo que duas réplicas do gateway consumam um
 * token da mesma chave no mesmo milissegundo, o Redis processa os scripts
 * um de cada vez, então não existe condição de corrida na leitura+escrita
 * do balde (o que existiria se fizéssemos GET, calculássemos em JS, e
 * depois SET como duas operações separadas).
 *
 * KEYS[1] = chave do balde
 * ARGV[1] = capacidade máxima do balde (maxTokens)
 * ARGV[2] = janela de reabastecimento em ms (refillWindowMs)
 * ARGV[3] = timestamp atual em ms (now)
 */
const TOKEN_BUCKET_SCRIPT = `
local maxTokens = tonumber(ARGV[1])
local refillWindowMs = tonumber(ARGV[2])
local now = tonumber(ARGV[3])

local bucket = redis.call('HMGET', KEYS[1], 'tokens', 'lastRefillAt')
local tokens = tonumber(bucket[1])
local lastRefillAt = tonumber(bucket[2])

if tokens == nil then
  tokens = maxTokens
  lastRefillAt = now
end

local elapsed = now - lastRefillAt
local refillRate = maxTokens / refillWindowMs
local refilled = math.min(maxTokens, tokens + elapsed * refillRate)

local allowed
local remaining
local retryAfterMs

if refilled < 1 then
  allowed = 0
  remaining = 0
  local msUntilNextToken = (1 - refilled) / refillRate
  retryAfterMs = math.ceil(msUntilNextToken)
  redis.call('HMSET', KEYS[1], 'tokens', refilled, 'lastRefillAt', now)
else
  allowed = 1
  retryAfterMs = 0
  local newTokens = refilled - 1
  redis.call('HMSET', KEYS[1], 'tokens', newTokens, 'lastRefillAt', now)
  remaining = math.floor(newTokens)
end

redis.call('PEXPIRE', KEYS[1], refillWindowMs * 2)

return { allowed, retryAfterMs, remaining }
`;

export class RedisRateLimiter implements RateLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly maxTokens: number,
    private readonly refillWindowMs: number,
    private readonly keyPrefix = "gateway:ratelimit:"
  ) {}

  async tryConsume(key: string): Promise<RateLimitResult> {
    const now = Date.now();
    const result = (await this.redis.eval(
      TOKEN_BUCKET_SCRIPT,
      1,
      this.keyPrefix + key,
      this.maxTokens,
      this.refillWindowMs,
      now
    )) as [number, number, number];

    const [allowed, retryAfterMs, remaining] = result;
    return { allowed: allowed === 1, retryAfterMs, remaining };
  }

  async reset(key: string): Promise<void> {
    await this.redis.del(this.keyPrefix + key);
  }
}
