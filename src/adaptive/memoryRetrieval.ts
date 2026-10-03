/**
 * Fase 6 — Memory Retrieval.
 *
 * ANTES do planejamento, recupera episódios/memórias relevantes do SQLite.
 * A busca considera: tags (categoria, capabilities), task similarity, lessons learned.
 *
 * NÃO carrega toda a memória — apenas o que é relevante.
 * FALHA ABERTA: se a memória falhar, retorna vazio e continua.
 */

import { memoriesRepo } from "../lib/db/index.js";
import type { TaskProfile } from "./taskAnalyzer.js";
import type { Memory } from "../lib/db/repos.js";

export interface RetrievedMemory {
  /** Episódio/memória original. */
  memory: Memory;
  /** Texto de busca que fez match. */
  matchedTag: string;
  /** Score de relevância (0-1). */
  relevance: number;
}

export interface MemoryRetrievalResult {
  memories: RetrievedMemory[];
  lessonsLearned: string[];
  totalRetrieved: number;
}

/**
 * Recupera memórias relevantes antes do planejamento.
 *
 * Busca por:
 * 1. Memórias com tags de categoria (ex: "codigo", "analise")
 * 2. Memórias com tags de capabilities (ex: "geracao_codigo", "validacao")
 * 3. Episódios relacionados à mesma tarefa
 */
export function retrieveRelevantMemory(
  task: string,
  profile: TaskProfile,
  options?: {
    maxResults?: number;
    /** Tags adicionais para busca. */
    extraTags?: string[];
  }
): MemoryRetrievalResult {
  const maxResults = options?.maxResults ?? 10;
  const memories: RetrievedMemory[] = [];
  const lessonsLearned: string[] = [];

  try {
    // Tags para busca: categoria + capabilities
    const tags: string[] = [
      profile.category,
      ...profile.capabilities,
      ...(options?.extraTags ?? []),
    ];

    // Busca por tags
    const tagMemories = tags.length > 0 ? memoriesRepo.searchByTags(tags, maxResults) : [];

    for (const mem of tagMemories) {
      const matchedTag = findMatchedTag(mem, tags);
      const relevance = calculateRelevance(mem, task, profile);

      memories.push({
        memory: mem,
        matchedTag,
        relevance,
      });

      // Extrai lessons learned da memória
      extractLessons(mem, lessonsLearned);
    }

    // Busca por tipo episódico (episódios relacionados)
    const episodicMemories = memoriesRepo.getByType("episodic", maxResults);
    for (const mem of episodicMemories) {
      if (!memories.some((m) => m.memory.id === mem.id)) {
        const relevance = calculateRelevance(mem, task, profile);

        // Só inclui se for relevante
        if (relevance > 0.3) {
          memories.push({
            memory: mem,
            matchedTag: "episodic",
            relevance,
          });

          extractLessons(mem, lessonsLearned);
        }
      }
    }

    // Ordena por relevância
    memories.sort((a, b) => b.relevance - a.relevance);

    // Limita resultados
    const limited = memories.slice(0, maxResults);

    return {
      memories: limited,
      lessonsLearned: deduplicate(lessonsLearned),
      totalRetrieved: limited.length,
    };
  } catch {
    // FALHA ABERTA: memory retrieval falhou → continua sem contexto
    return {
      memories: [],
      lessonsLearned: [],
      totalRetrieved: 0,
    };
  }
}

/** Encontra qual tag fez match com a memória. */
function findMatchedTag(memory: Memory, tags: string[]): string {
  const tagsJson = memory.tags_json;
  if (!tagsJson) return "unknown";

  try {
    const memoryTags = JSON.parse(tagsJson) as string[];
    for (const tag of tags) {
      if (memoryTags.includes(tag)) {
        return tag;
      }
    }
  } catch {
    // ignore parse error
  }

  return "unknown";
}

/** Calcula relevância de uma memória para a tarefa atual. */
function calculateRelevance(
  memory: Memory,
  task: string,
  profile: TaskProfile
): number {
  let score = memory.relevance_score ?? 1.0;

  // Boost por acesso recente
  if (memory.last_accessed) {
    const daysSinceAccess = (Date.now() / 1000 - memory.last_accessed) / 86400;
    score *= Math.max(0.5, 1.0 - daysSinceAccess * 0.1);
  }

  // Boost se contém palavras-chave da tarefa
  const memoryText = (memory.embedding_text ?? memory.content_json ?? "").toLowerCase();
  const taskWords = task.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
  const matchedWords = taskWords.filter((w) => memoryText.includes(w));
  if (taskWords.length > 0) {
    score *= 1.0 + (matchedWords.length / taskWords.length) * 0.5;
  }

  // Boost se contém capabilities da tarefa
  const capsJson = memory.tags_json;
  if (capsJson) {
    try {
      const memoryTags = JSON.parse(capsJson) as string[];
      const matchedCaps = profile.capabilities.filter((cap) => memoryTags.includes(cap));
      if (profile.capabilities.length > 0) {
        score *= 1.0 + (matchedCaps.length / profile.capabilities.length) * 0.3;
      }
    } catch {
      // ignore
    }
  }

  // Penaliza por baixa relevância
  if (memory.relevance_score !== undefined && memory.relevance_score < 0.5) {
    score *= 0.7;
  }

  return Math.min(1.0, Math.max(0.0, score));
}

/** Extrai lessons learned do content_json de uma memória. */
function extractLessons(memory: Memory, lessons: string[]): void {
  try {
    const content = JSON.parse(memory.content_json) as {
      lessons_learned?: string[];
      finalResult?: string;
      task?: string;
      insights?: string;
    };

    if (content.lessons_learned && Array.isArray(content.lessons_learned)) {
      lessons.push(...content.lessons_learned);
    }

    if (content.insights) {
      lessons.push(content.insights);
    }

    // Extrai insights do finalResult
    if (content.finalResult && content.finalResult.length > 20) {
      lessons.push(`Resultado anterior: ${content.finalResult.substring(0, 100)}...`);
    }
  } catch {
    // ignore parse error
  }
}

/** Remove duplicatas de array de strings. */
function deduplicate(arr: string[]): string[] {
  const seen = new Set<string>();
  return arr.filter((item) => {
    if (seen.has(item)) return false;
    seen.add(item);
    return true;
  });
}
