/**
 * Fase 6 — Migrations do banco de dados autônomo.
 *
 * Schema para persistir episódios de execução autônoma:
 * - episodes: execuções completas (task, plano, resultado final)
 * - steps: passos individuais dentro de um episódio
 * - validations: validações realizadas (heurísticas + critic LLM)
 * - memories: conhecimentos/insights extraídos (long-term memory)
 */

import { getDriver } from "./driver.js";

export const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS episodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    task TEXT NOT NULL,
    strategy TEXT NOT NULL,
    plan_json TEXT,
    final_result TEXT,
    final_status TEXT NOT NULL, -- 'success' | 'failure' | 'budget_exceeded' | 'timeout' | 'max_iterations' | 'max_tool_calls' | 'max_tokens' | 'no_progress'
    total_iterations INTEGER DEFAULT 0,
    total_cost_usd REAL,
    total_duration_ms INTEGER,
    started_at INTEGER NOT NULL,
    completed_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_episodes_session ON episodes(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_episodes_started ON episodes(started_at)`,

  `CREATE TABLE IF NOT EXISTS steps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    episode_id INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
    iteration INTEGER NOT NULL,
    step_type TEXT NOT NULL, -- 'plan' | 'execute' | 'observe' | 'validate' | 'correct' | 'replan'
    action_json TEXT NOT NULL,
    observation_json TEXT,
    validation_json TEXT,
    decision TEXT NOT NULL, -- 'continue' | 'correct' | 'replan' | 'finish'
    cost_usd REAL,
    duration_ms INTEGER,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_steps_episode ON steps(episode_id)`,

  `CREATE TABLE IF NOT EXISTS validations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    step_id INTEGER NOT NULL REFERENCES steps(id) ON DELETE CASCADE,
    validator_type TEXT NOT NULL, -- 'heuristic' | 'critic_llm'
    passed INTEGER NOT NULL, -- 0 | 1
    confidence REAL,
    issues_json TEXT,
    suggested_correction TEXT,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_validations_step ON validations(step_id)`,

  `CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL, -- 'episodic' | 'semantic' | 'procedural'
    episode_id INTEGER REFERENCES episodes(id) ON DELETE SET NULL,
    content_json TEXT NOT NULL,
    embedding_text TEXT, -- para busca semântica futura
    tags_json TEXT, -- array de tags
    relevance_score REAL DEFAULT 1.0,
    access_count INTEGER DEFAULT 0,
    last_accessed INTEGER,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type)`,
  `CREATE INDEX IF NOT EXISTS idx_memories_episode ON memories(episode_id)`,
  `CREATE INDEX IF NOT EXISTS idx_memories_relevance ON memories(relevance_score DESC)`,

  // ─── Fase 7 — Self Evolution Layer ─────────────────────────────────────

  `CREATE TABLE IF NOT EXISTS curiosity_signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    task_signature TEXT NOT NULL,
    should_explore INTEGER NOT NULL DEFAULT 0, -- 0 | 1
    reason TEXT,
    priority REAL,
    suggested_knowledge TEXT,
    triggered_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_curiosity_session ON curiosity_signals(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_curiosity_triggered ON curiosity_signals(triggered_at DESC)`,

  `CREATE TABLE IF NOT EXISTS goals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    goal_id TEXT UNIQUE NOT NULL,
    description TEXT NOT NULL,
    priority REAL,
    type TEXT NOT NULL, -- 'improve' | 'learn' | 'optimize'
    achieved INTEGER NOT NULL DEFAULT 0, -- 0 | 1
    generated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_goals_session ON goals(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_goals_type ON goals(type)`,

  `CREATE TABLE IF NOT EXISTS metabolism_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    tokens_available INTEGER,
    budget_available REAL,
    efficiency_score REAL,
    risk_level TEXT, -- 'low' | 'medium' | 'high'
    taken_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_metabolism_session ON metabolism_snapshots(session_id)`,

  `CREATE TABLE IF NOT EXISTS skills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    success_rate REAL,
    usage_count INTEGER,
    confidence REAL,
    last_updated INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_skills_session ON skills(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_skills_name ON skills(name)`,

  `CREATE TABLE IF NOT EXISTS strategy_scores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    strategy TEXT NOT NULL,
    success_rate REAL,
    avg_cost REAL,
    avg_time REAL,
    sample_count INTEGER,
    last_updated INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_strategy_session ON strategy_scores(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_strategy_name ON strategy_scores(strategy)`,

  `CREATE TABLE IF NOT EXISTS reflections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    episode_id INTEGER REFERENCES episodes(id) ON DELETE SET NULL,
    task TEXT NOT NULL,
    plan_worked INTEGER NOT NULL DEFAULT 0, -- 0 | 1
    failed_step TEXT,
    improvement_suggestion TEXT,
    missing_knowledge TEXT,
    lessons TEXT, -- JSON array
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_reflections_session ON reflections(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_reflections_episode ON reflections(episode_id)`,

  // ─── Memória de sessão persistente + rastreamento de artefatos ─────────
  //
  // Antes disso, a memória de curto prazo (`SessionMemoryStore`) só existia
  // em RAM (perdida a cada restart do processo) e — pior — nunca era sequer
  // instanciada/injetada na rota /v1/run em produção (ver src/app.ts), então
  // a conversa nunca tinha memória de verdade. Também não existia NENHUM
  // registro de que arquivo foi enviado, extraído ou gerado em qual sessão
  // — por isso "o projeto atual"/"esse zip" nunca resolvia a nada.

  `CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL, -- 'user' | 'assistant'
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at)`,

  `CREATE TABLE IF NOT EXISTS artifacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    name TEXT NOT NULL,             -- ex.: "axon-corrigido6.zip"
    -- 'uploaded_file' | 'uploaded_zip' | 'extracted_dir' | 'generated_file' |
    -- 'generated_zip' | 'generated_project'
    type TEXT NOT NULL,
    workspace_path TEXT NOT NULL,   -- caminho relativo à raiz do workspace
    parent_artifact_id INTEGER REFERENCES artifacts(id) ON DELETE SET NULL,
    metadata_json TEXT,             -- ex.: lista de arquivos, projectName, etc.
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_artifacts_session ON artifacts(session_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_artifacts_parent ON artifacts(parent_artifact_id)`,

  // Uma linha por sessão: qual artefato/projeto é "o atual" agora — a
  // resolução de "esse zip"/"o projeto atual" é DETERMINÍSTICA (lida daqui),
  // não deixada para o LLM adivinhar a partir do histórico bruto.
  `CREATE TABLE IF NOT EXISTS session_context (
    session_id TEXT PRIMARY KEY,
    current_artifact_id INTEGER REFERENCES artifacts(id) ON DELETE SET NULL,
    current_project_id INTEGER REFERENCES artifacts(id) ON DELETE SET NULL,
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
  )`,
];

/** Executa todas as migrations */
export function runMigrations(): void {
  const driver = getDriver();
  driver.transaction(() => {
    for (const sql of MIGRATIONS) {
      driver.exec(sql);
    }
  });
}

/** Verifica se migrations já foram executadas */
export function checkMigrations(): boolean {
  try {
    const driver = getDriver();
    const result = driver.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='episodes'").get();
    return !!result;
  } catch {
    return false;
  }
}

/**
 * Inicializa o banco (roda as migrations). Sempre executa — cada statement é
 * `CREATE TABLE/INDEX IF NOT EXISTS`, então rodar de novo em um banco já
 * migrado é uma operação barata e no-op. Antes disso, só rodava quando a
 * tabela `episodes` não existia — o que significava que QUALQUER tabela
 * adicionada depois da primeira migration nunca era criada em um banco já
 * existente (só em instalações 100% novas). `checkMigrations()` continua
 * exportada para quem só quer inspecionar o estado, sem decidir mais nada.
 */
export function initializeDatabase(): void {
  runMigrations();
}