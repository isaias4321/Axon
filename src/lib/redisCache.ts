import { type Redis } from "ioredis";
import type { CacheStore } from "./cache.js";

/**
 * Cache distribuído com Redis: mesma interface pública do `TtlCache`, mas
 * o estado fica compartilhado entre todas as réplicas do gateway em vez
 * de isolado por processo.
 *
 * Usa `SET key value PX ttlMs` — o próprio Redis expira a chave, sem
 * precisar de nenhuma lógica extra de limpeza.
 */
export class RedisCache<Value> implements CacheStore<Value> {
  constructor(
    private readonly redis: Redis,
    private readonly ttlMs: number,
    private readonly keyPrefix = "gateway:cache:"
  ) {}

  async get(key: string): Promise<Value | undefined> {
    const raw = await this.redis.get(this.keyPrefix + key);
    if (raw === null) return undefined;
    try {
      return JSON.parse(raw) as Value;
    } catch {
      // Valor corrompido/serializado por uma versão incompatível — trata
      // como cache miss em vez de derrubar a requisição.
      return undefined;
    }
  }

  async set(key: string, value: Value): Promise<void> {
    await this.redis.set(this.keyPrefix + key, JSON.stringify(value), "PX", this.ttlMs);
  }

  async clear(): Promise<void> {
    const keys = await this.redis.keys(`${this.keyPrefix}*`);
    if (keys.length > 0) await this.redis.del(...keys);
  }
}
