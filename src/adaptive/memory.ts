/**
 * Fase 4 — Agent Runtime: memória de sessão (short-term).
 *
 * `InMemorySessionStore` guarda turnos (`user`/`assistant`) por sessão, em
 * FIFO com limite de turnos por sessão (o turno mais antigo sai primeiro —
 * janela deslizante, barata e previsível). Sem timestamps e sem IO: é a
 * fonte única da memória em sessão, reusável por fases futuras (F5/F6).
 *
 * Persiste apenas enquanto o processo está vivo. `SqliteSessionStore`
 * (abaixo) implementa a mesma interface persistindo no SQLite — use essa
 * em produção quando a conversa precisa sobreviver a um restart.
 */

import { messagesRepo } from "../lib/db/sessionRepo.js";

export interface MemoryTurn {
  role: "user" | "assistant";
  content: string;
}

export interface SessionMemoryStore {
  /** Adiciona um turno à sessão, respeitando o limite FIFO. */
  remember(sessionId: string, turn: MemoryTurn): void;
  /** Turnos da sessão, na ordem, sem mutar o estado. */
  recall(sessionId: string): readonly MemoryTurn[];
  /** Limpa a sessão. */
  clearSession(sessionId: string): void;
}

/** Limite padrão de turnos por sessão. */
export const DEFAULT_MAX_TURNS_PER_SESSION = 10;

export class InMemorySessionStore implements SessionMemoryStore {
  private readonly sessions = new Map<string, MemoryTurn[]>();

  constructor(
    private readonly maxTurnsPerSession: number = DEFAULT_MAX_TURNS_PER_SESSION
  ) {}

  remember(sessionId: string, turn: MemoryTurn): void {
    const turns = this.sessions.get(sessionId) ?? [];
    turns.push(turn);
    if (turns.length > this.maxTurnsPerSession) {
      turns.splice(0, turns.length - this.maxTurnsPerSession);
    }
    this.sessions.set(sessionId, turns);
  }

  recall(sessionId: string): readonly MemoryTurn[] {
    return this.sessions.get(sessionId) ?? [];
  }

  clearSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}

/**
 * Implementação de `SessionMemoryStore` persistida no SQLite (tabela
 * `messages` — ver `src/lib/db/sessionRepo.ts`), em vez de só em RAM.
 *
 * Por que isso importa: `InMemorySessionStore` perde tudo a cada restart do
 * processo (reinício de container, deploy, crash). Para um agente que lida
 * com arquivos/projetos ao longo de uma conversa que pode durar bem mais que
 * a vida de um processo, isso é uma limitação real — esta classe resolve
 * isso sem mudar NADA em quem já usa `SessionMemoryStore` (mesma interface,
 * substituição direta).
 */
export class SqliteSessionStore implements SessionMemoryStore {
  constructor(private readonly maxTurnsPerSession: number = DEFAULT_MAX_TURNS_PER_SESSION) {}

  remember(sessionId: string, turn: MemoryTurn): void {
    messagesRepo.create({ session_id: sessionId, role: turn.role, content: turn.content });
  }

  recall(sessionId: string): readonly MemoryTurn[] {
    return messagesRepo
      .getRecentBySession(sessionId, this.maxTurnsPerSession)
      .map((m) => ({ role: m.role, content: m.content }));
  }

  clearSession(sessionId: string): void {
    messagesRepo.deleteBySession(sessionId);
  }
}
