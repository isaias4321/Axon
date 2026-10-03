/**
 * Memória de sessão persistente (mensagens) + rastreamento de artefatos.
 *
 * Por que isto existe separado de `src/adaptive/memory.ts`
 * (`InMemorySessionStore`): aquela classe guarda turnos só em RAM, perdidos
 * a cada restart — e, mais grave, nunca chegou a ser instanciada/injetada
 * na rota /v1/run em produção (ver correção em src/app.ts), então a
 * "memória de sessão" nunca rodava de verdade. Esta camada persiste no
 * mesmo SQLite já usado para episodes/steps/skills (ver migrations.ts),
 * e adiciona o conceito que não existia: um ARTEFATO (arquivo enviado,
 * pasta extraída, arquivo/projeto gerado) associado a uma sessão, com uma
 * noção determinística de qual é "o atual" — para que "o projeto atual"/
 * "esse zip" resolvam a um caminho real sem depender do LLM adivinhar a
 * partir do texto bruto do histórico.
 */

import { getDriver } from "./driver.js";

function driver() {
  return getDriver();
}

// ─── Mensagens (memória de sessão persistente) ───────────────────────────

export interface SessionMessage {
  id: number;
  session_id: string;
  role: "user" | "assistant";
  content: string;
  created_at: number;
}

export interface SessionMessageInput {
  session_id: string;
  role: "user" | "assistant";
  content: string;
}

export const messagesRepo = {
  create(input: SessionMessageInput): SessionMessage {
    const db = driver();
    const stmt = db.prepare(`INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)`);
    const result = stmt.run(input.session_id, input.role, input.content);
    return this.getById(result.lastInsertRowid as number)!;
  },

  getById(id: number): SessionMessage | null {
    const db = driver();
    return db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as SessionMessage | null;
  },

  /** Últimas `limit` mensagens da sessão, em ordem cronológica (mais antiga primeiro). */
  getRecentBySession(sessionId: string, limit: number): SessionMessage[] {
    const db = driver();
    const rows = db
      .prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY created_at DESC, id DESC LIMIT ?")
      .all(sessionId, limit) as SessionMessage[];
    return rows.reverse();
  },

  deleteBySession(sessionId: string): void {
    const db = driver();
    db.prepare("DELETE FROM messages WHERE session_id = ?").run(sessionId);
  },
};

// ─── Artefatos (uploads, extrações, arquivos/projetos gerados) ──────────

export type ArtifactType =
  | "uploaded_file"
  | "uploaded_zip"
  | "extracted_dir"
  | "generated_file"
  | "generated_zip"
  | "generated_project";

export interface Artifact {
  id: number;
  session_id: string;
  name: string;
  type: ArtifactType;
  workspace_path: string;
  parent_artifact_id: number | null;
  metadata_json: string | null;
  created_at: number;
}

export interface ArtifactInput {
  session_id: string;
  name: string;
  type: ArtifactType;
  workspace_path: string;
  parent_artifact_id?: number | null;
  metadata?: Record<string, unknown> | null;
}

export const artifactsRepo = {
  create(input: ArtifactInput): Artifact {
    const db = driver();
    const stmt = db.prepare(`
      INSERT INTO artifacts (session_id, name, type, workspace_path, parent_artifact_id, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      input.session_id,
      input.name,
      input.type,
      input.workspace_path,
      input.parent_artifact_id ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null
    );
    return this.getById(result.lastInsertRowid as number)!;
  },

  getById(id: number): Artifact | null {
    const db = driver();
    return db.prepare("SELECT * FROM artifacts WHERE id = ?").get(id) as Artifact | null;
  },

  getBySession(sessionId: string, limit = 50): Artifact[] {
    const db = driver();
    return db
      .prepare("SELECT * FROM artifacts WHERE session_id = ? ORDER BY created_at DESC, id DESC LIMIT ?")
      .all(sessionId, limit) as Artifact[];
  },

  /**
   * Encontra o artefato mais recente da sessão cujo `workspace_path` bate
   * exatamente com o caminho dado — usado para ligar uma extração/geração
   * ao artefato de origem (`parent_artifact_id`) quando quem chama só tem
   * o caminho em disco, não o id.
   */
  findByWorkspacePath(sessionId: string, workspacePath: string): Artifact | null {
    const db = driver();
    const rows = db
      .prepare("SELECT * FROM artifacts WHERE session_id = ? AND workspace_path = ? ORDER BY created_at DESC LIMIT 1")
      .all(sessionId, workspacePath) as Artifact[];
    return rows[0] ?? null;
  },
};

// ─── Contexto da sessão (artefato/projeto "atual") ───────────────────────

export interface SessionContextRow {
  session_id: string;
  current_artifact_id: number | null;
  current_project_id: number | null;
  updated_at: number;
}

export const sessionContextRepo = {
  get(sessionId: string): SessionContextRow | null {
    const db = driver();
    return db.prepare("SELECT * FROM session_context WHERE session_id = ?").get(sessionId) as SessionContextRow | null;
  },

  /** Upsert parcial: só sobrescreve os campos passados (undefined = mantém o valor atual). */
  set(sessionId: string, update: { current_artifact_id?: number | null; current_project_id?: number | null }): void {
    const db = driver();
    const existing = this.get(sessionId);
    const currentArtifactId =
      update.current_artifact_id !== undefined ? update.current_artifact_id : (existing?.current_artifact_id ?? null);
    const currentProjectId =
      update.current_project_id !== undefined ? update.current_project_id : (existing?.current_project_id ?? null);

    db.prepare(`
      INSERT INTO session_context (session_id, current_artifact_id, current_project_id, updated_at)
      VALUES (?, ?, ?, strftime('%s', 'now'))
      ON CONFLICT(session_id) DO UPDATE SET
        current_artifact_id = excluded.current_artifact_id,
        current_project_id = excluded.current_project_id,
        updated_at = excluded.updated_at
    `).run(sessionId, currentArtifactId, currentProjectId);
  },
};
