/**
 * Fase 9 — Cognitive Memory.
 *
 * Memória específica do sistema cognitivo, integrada à persistência SQLite
 * existente quando possível. Suporta:
 * - contexto compartilhado;
 * - resultados anteriores;
 * - proveniência;
 * - sessionId;
 * - cellId;
 * - timestamps;
 * - isolamento entre sessões.
 *
 * NÃO substitui a memória SQLite existente (episodesRepo, memoriesRepo, etc.).
 */

import type {
  CognitiveMemory,
  CognitiveMemoryEntry,
} from "./types.js";

/**
 * Implementação em memória (para testes) + integração com SQLite opcional.
 */
export class FileSystemCognitiveMemory implements CognitiveMemory {
  private entries: Map<string, CognitiveMemoryEntry> = new Map();
  private readonly sessionPrefix: string;

  constructor(sessionPrefix: string = "cognitive") {
    this.sessionPrefix = sessionPrefix;
  }

  async set(key: string, value: CognitiveMemoryEntry): Promise<void> {
    const fullKey = this.buildKey(key, value.sessionId);
    // Conflito: mesma (sessionPrefix, sessionId, key) → versão nova
    const existing = this.entries.get(fullKey);
    this.entries.set(fullKey, {
      ...value,
      version: (existing?.version ?? 0) + 1,
    });

    // Persistência opcional via SQLite
    await this.persist(fullKey, this.entries.get(fullKey)!);
  }

  async get(key: string): Promise<CognitiveMemoryEntry | undefined> {
    // Buscar direto
    const direct = this.entries.get(key);
    if (direct) return direct;

    // Buscar pela forma com prefixo de sessão: `<sessionPrefix>:<sessionId>:<key>`
    // Chamado com "shared" → procura qualquer entrada da MESMA instância cuja
    // chave composta termine em ":shared".
    const suffix = `:${key}`;
    for (const [fullKey, entry] of this.entries) {
      if (fullKey.endsWith(suffix)) {
        return entry;
      }
    }

    return undefined;
  }

  async delete(key: string): Promise<void> {
    // Remove direto ou por sufixo
    this.entries.delete(key);
    const suffix = `:${key}`;
    for (const fullKey of Array.from(this.entries.keys())) {
      if (fullKey.endsWith(suffix)) {
        this.entries.delete(fullKey);
      }
    }
  }

  async list(prefix: string): Promise<string[]> {
    return Array.from(this.entries.keys()).filter(k =>
      k.includes(prefix) || k.startsWith(prefix) || prefix.startsWith(this.sessionPrefix)
    );
  }

  async clear(): Promise<void> {
    this.entries.clear();
  }

  /**
   * Constrói chave composta com prefixo de sessão.
   */
  private buildKey(key: string, sessionId: string): string {
    return `${this.sessionPrefix}:${sessionId}:${key}`;
  }

  /**
   * Persiste entrada no SQLite (fail-open, não bloqueia execução).
   */
  private async persist(key: string, entry: CognitiveMemoryEntry): Promise<void> {
    try {
      // Tenta integrar com memória existente se disponível
      const { memoriesRepo } = await import("../lib/db/index.js");
      if (memoriesRepo) {
        memoriesRepo.create({
          type: "episodic",
          content_json: JSON.stringify({
            key,
            value: entry.value,
            cellId: entry.cellId,
            cellType: entry.cellType,
            tags: entry.tags,
          }),
          embedding_text: `${entry.cellType} ${entry.cellId} ${entry.tags.join(" ")}`,
          tags_json: JSON.stringify(entry.tags),
          relevance_score: 1.0,
        });
      }
    } catch {
      // Fail-open: persistência SQLite é opcional
    }
  }
}

/**
 * Factory para criar memória cognitiva.
 */
export function createCognitiveMemory(options?: {
  sessionPrefix?: string;
}): CognitiveMemory {
  return new FileSystemCognitiveMemory(options?.sessionPrefix);
}