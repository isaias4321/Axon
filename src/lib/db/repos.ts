/**
 * Fase 6 — Repositórios para memória long-term.
 *
 * Operações CRUD para episodes, steps, validations, memories.
 * Interface síncrona (better-sqlite3 é síncrono).
 */

import { getDriver } from "./driver.js";
import type { SQLInputValue } from "node:sqlite";

/** Tipos de episódio */
export interface Episode {
  id: number;
  session_id: string;
  task: string;
  strategy: string;
  plan_json: string | null;
  final_result: string | null;
  final_status: "success" | "failure" | "budget_exceeded" | "timeout" | "max_iterations" | "max_tool_calls" | "max_tokens" | "no_progress";
  total_iterations: number;
  total_cost_usd: number | null;
  total_duration_ms: number | null;
  started_at: number;
  completed_at: number | null;
  created_at: number;
}

export interface EpisodeInput {
  session_id: string;
  task: string;
  strategy: string;
  plan_json?: string | null;
}

export interface EpisodeUpdate {
  final_result?: string | null;
  final_status?: "success" | "failure" | "budget_exceeded" | "timeout" | "max_iterations" | "max_tool_calls" | "max_tokens" | "no_progress";
  total_iterations?: number;
  total_cost_usd?: number | null;
  total_duration_ms?: number | null;
  completed_at?: number | null;
}

/** Tipos de passo */
export interface Step {
  id: number;
  episode_id: number;
  iteration: number;
  step_type: "plan" | "execute" | "observe" | "validate" | "correct" | "replan";
  action_json: string;
  observation_json: string | null;
  validation_json: string | null;
  decision: "continue" | "correct" | "replan" | "finish";
  cost_usd: number | null;
  duration_ms: number | null;
  created_at: number;
}

export interface StepInput {
  episode_id: number;
  iteration: number;
  step_type: "plan" | "execute" | "observe" | "validate" | "correct" | "replan";
  action_json: string;
  observation_json?: string | null;
  validation_json?: string | null;
  decision: "continue" | "correct" | "replan" | "finish";
  cost_usd?: number | null;
  duration_ms?: number | null;
}

/** Tipos de validação */
export interface Validation {
  id: number;
  step_id: number;
  validator_type: "heuristic" | "critic_llm";
  passed: number;
  confidence: number | null;
  issues_json: string | null;
  suggested_correction: string | null;
  created_at: number;
}

export interface ValidationInput {
  step_id: number;
  validator_type: "heuristic" | "critic_llm";
  passed: boolean;
  confidence?: number | null;
  issues_json?: string | null;
  suggested_correction?: string | null;
}

/** Tipos de memória long-term */
export interface Memory {
  id: number;
  type: "episodic" | "semantic" | "procedural";
  episode_id: number | null;
  content_json: string;
  embedding_text: string | null;
  tags_json: string | null;
  relevance_score: number;
  access_count: number;
  last_accessed: number | null;
  created_at: number;
}

export interface MemoryInput {
  type: "episodic" | "semantic" | "procedural";
  episode_id?: number | null;
  content_json: string;
  embedding_text?: string | null;
  tags_json?: string | null;
  relevance_score?: number;
}

function driver() {
  return getDriver();
}

/** Repository para Episodes */
export const episodesRepo = {
  create(input: EpisodeInput): Episode {
    const db = driver();
    const now = Math.floor(Date.now() / 1000);
    const stmt = db.prepare(`
      INSERT INTO episodes (session_id, task, strategy, plan_json, final_status, total_iterations, started_at)
      VALUES (?, ?, ?, ?, 'failure', 0, ?)
    `);
    const result = stmt.run(input.session_id, input.task, input.strategy, input.plan_json ?? null, now);
    return this.getById(result.lastInsertRowid as number)!;
  },

  getById(id: number): Episode | null {
    const db = driver();
    return db.prepare("SELECT * FROM episodes WHERE id = ?").get(id) as Episode | null;
  },

  getBySession(sessionId: string, limit = 50): Episode[] {
    const db = driver();
    return db.prepare("SELECT * FROM episodes WHERE session_id = ? ORDER BY started_at DESC LIMIT ?").all(sessionId, limit) as Episode[];
  },

  update(id: number, update: EpisodeUpdate): void {
    const db = driver();
    const fields: string[] = [];
    const params: SQLInputValue[] = [];
    for (const [key, value] of Object.entries(update)) {
      if (value !== undefined) {
        fields.push(`${key} = ?`);
        params.push(value as SQLInputValue);
      }
    }
    if (fields.length === 0) return;
    params.push(id);
    db.prepare(`UPDATE episodes SET ${fields.join(", ")} WHERE id = ?`).run(...params);
  },

  complete(id: number, finalResult: string, finalStatus: Episode["final_status"], totalIterations: number, totalCostUsd: number | null, totalDurationMs: number): void {
    const db = driver();
    const now = Math.floor(Date.now() / 1000);
    db.prepare(`
      UPDATE episodes
      SET final_result = ?, final_status = ?, total_iterations = ?, total_cost_usd = ?, total_duration_ms = ?, completed_at = ?
      WHERE id = ?
    `).run(finalResult, finalStatus, totalIterations, totalCostUsd, totalDurationMs, now, id);
  },
};

/** Repository para Steps */
export const stepsRepo = {
  create(input: StepInput): Step {
    const db = driver();
    const stmt = db.prepare(`
      INSERT INTO steps (episode_id, iteration, step_type, action_json, observation_json, validation_json, decision, cost_usd, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      input.episode_id,
      input.iteration,
      input.step_type,
      input.action_json,
      input.observation_json ?? null,
      input.validation_json ?? null,
      input.decision,
      input.cost_usd ?? null,
      input.duration_ms ?? null
    );
    return this.getById(result.lastInsertRowid as number)!;
  },

  getById(id: number): Step | null {
    const db = driver();
    return db.prepare("SELECT * FROM steps WHERE id = ?").get(id) as Step | null;
  },

  getByEpisode(episodeId: number): Step[] {
    const db = driver();
    return db.prepare("SELECT * FROM steps WHERE episode_id = ? ORDER BY iteration, id").all(episodeId) as Step[];
  },

  getByEpisodeAndIteration(episodeId: number, iteration: number): Step[] {
    const db = driver();
    return db.prepare("SELECT * FROM steps WHERE episode_id = ? AND iteration = ? ORDER BY id").all(episodeId, iteration) as Step[];
  },
};

/** Repository para Validations */
export const validationsRepo = {
  create(input: ValidationInput): Validation {
    const db = driver();
    const stmt = db.prepare(`
      INSERT INTO validations (step_id, validator_type, passed, confidence, issues_json, suggested_correction)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      input.step_id,
      input.validator_type,
      input.passed ? 1 : 0,
      input.confidence ?? null,
      input.issues_json ?? null,
      input.suggested_correction ?? null
    );
    return this.getById(result.lastInsertRowid as number)!;
  },

  getById(id: number): Validation | null {
    const db = driver();
    return db.prepare("SELECT * FROM validations WHERE id = ?").get(id) as Validation | null;
  },

  getByStep(stepId: number): Validation[] {
    const db = driver();
    return db.prepare("SELECT * FROM validations WHERE step_id = ? ORDER BY created_at").all(stepId) as Validation[];
  },
};

/** Repository para Memories */
export const memoriesRepo = {
  create(input: MemoryInput): Memory {
    const db = driver();
    const stmt = db.prepare(`
      INSERT INTO memories (type, episode_id, content_json, embedding_text, tags_json, relevance_score)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      input.type,
      input.episode_id ?? null,
      input.content_json,
      input.embedding_text ?? null,
      input.tags_json ?? null,
      input.relevance_score ?? 1.0
    );
    return this.getById(result.lastInsertRowid as number)!;
  },

  getById(id: number): Memory | null {
    const db = driver();
    return db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as Memory | null;
  },

  getByType(type: "episodic" | "semantic" | "procedural", limit = 100): Memory[] {
    const db = driver();
    return db.prepare("SELECT * FROM memories WHERE type = ? ORDER BY relevance_score DESC, last_accessed DESC LIMIT ?").all(type, limit) as Memory[];
  },

  getByEpisode(episodeId: number): Memory[] {
    const db = driver();
    return db.prepare("SELECT * FROM memories WHERE episode_id = ? ORDER BY created_at").all(episodeId) as Memory[];
  },

  searchByTags(tags: string[], limit = 20): Memory[] {
    if (tags.length === 0) return [];
    const db = driver();
    // Busca simples por tags (contém qualquer uma das tags)
    const placeholders = tags.map(() => "tags_json LIKE ?").join(" OR ");
    const params: SQLInputValue[] = tags.map(t => `%"${t}"%`);
    params.push(limit);
    return db.prepare(`SELECT * FROM memories WHERE ${placeholders} ORDER BY relevance_score DESC LIMIT ?`).all(...params) as Memory[];
  },

  access(id: number): void {
    const db = driver();
    const now = Math.floor(Date.now() / 1000);
    db.prepare("UPDATE memories SET access_count = access_count + 1, last_accessed = ? WHERE id = ?").run(now, id);
  },

  updateRelevance(id: number, score: number): void {
    const db = driver();
    db.prepare("UPDATE memories SET relevance_score = ? WHERE id = ?").run(score, id);
  },
};

/** Fase 7 — shared repo-level types. */
export type GoalType = "improve" | "learn" | "optimize";

/** Repository for Curiosity Signals. */
export interface CuriositySignal {
  id: number;
  session_id: string;
  task_signature: string;
  should_explore: number; // 0|1
  reason: string;
  priority: number;
  suggested_knowledge: string;
  triggered_at: number;
}
export interface CuriositySignalInput {
  session_id: string;
  task_signature: string;
  should_explore: boolean;
  reason: string;
  priority: number;
  suggested_knowledge: string;
}
export const curiositySignalsRepo = {
  create(input: CuriositySignalInput): CuriositySignal {
    const db = driver();
    const stmt = db.prepare(`
      INSERT INTO curiosity_signals (session_id, task_signature, should_explore, reason, priority, suggested_knowledge)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      input.session_id,
      input.task_signature,
      input.should_explore ? 1 : 0,
      input.reason,
      input.priority,
      input.suggested_knowledge,
    );
    return this.getById(result.lastInsertRowid as number)!;
  },
  getById(id: number): CuriositySignal | null {
    const db = driver();
    return db.prepare("SELECT * FROM curiosity_signals WHERE id = ?").get(id) as CuriositySignal | null;
  },
  getBySession(sessionId: string, limit = 20): CuriositySignal[] {
    const db = driver();
    return db.prepare("SELECT * FROM curiosity_signals WHERE session_id = ? ORDER BY triggered_at DESC LIMIT ?").all(sessionId, limit) as CuriositySignal[];
  },
};

/** Repository for Goals. */
export interface Goal {
  id: string;
  goal_id: string;
  session_id: string;
  description: string;
  priority: number;
  type: GoalType; // 'improve' | 'learn' | 'optimize'
  achieved: number; // 0|1
  generated_at: number;
}
export interface GoalInput {
  session_id: string;
  goal_id: string;
  description: string;
  priority: number;
  type: GoalType;
}
export const goalsRepo = {
  create(input: GoalInput): Goal {
    const db = driver();
    const stmt = db.prepare(`
      INSERT INTO goals (session_id, goal_id, description, priority, type, achieved, generated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const now = Math.floor(Date.now() / 1000);
    const result = stmt.run(
      input.session_id,
      input.goal_id,
      input.description,
      input.priority,
      input.type,
      0,
      now,
    );
    return this.getById(result.lastInsertRowid as number)!;
  },
  getById(id: number): Goal | null {
    const db = driver();
    return db.prepare("SELECT * FROM goals WHERE id = ?").get(id) as Goal | null;
  },
  getBySession(sessionId: string, limit = 50): Goal[] {
    const db = driver();
    return db.prepare("SELECT * FROM goals WHERE session_id = ? ORDER BY generated_at DESC LIMIT ?").all(sessionId, limit) as Goal[];
  },
  markAchieved(goalId: string): void {
    const db = driver();
    db.prepare("UPDATE goals SET achieved = 1 WHERE goal_id = ?").run(goalId);
  },
};

/** Repository for Metabolism Snapshots. */
export interface MetabolismSnapshot {
  id: number;
  session_id: string;
  tokens_available: number;
  budget_available: number;
  efficiency_score: number;
  risk_level: string; // 'low' | 'medium' | 'high'
  taken_at: number;
}
export interface MetabolismSnapshotInput {
  session_id: string;
  tokens_available: number;
  budget_available: number;
  efficiency_score: number;
  risk_level: string;
  taken_at: number;
}
export const metabolismRepo = {
  create(input: MetabolismSnapshotInput): MetabolismSnapshot {
    const db = driver();
    const stmt = db.prepare(`
      INSERT INTO metabolism_snapshots (session_id, tokens_available, budget_available, efficiency_score, risk_level, taken_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      input.session_id,
      input.tokens_available,
      input.budget_available,
      input.efficiency_score,
      input.risk_level,
      input.taken_at,
    );
    return this.getById(result.lastInsertRowid as number)!;
  },
  getById(id: number): MetabolismSnapshot | null {
    const db = driver();
    return db.prepare("SELECT * FROM metabolism_snapshots WHERE id = ?").get(id) as MetabolismSnapshot | null;
  },
  getRecent(sessionId: string, limit = 10): MetabolismSnapshot[] {
    const db = driver();
    return db.prepare("SELECT * FROM metabolism_snapshots WHERE session_id = ? ORDER BY taken_at DESC LIMIT ?").all(sessionId, limit) as MetabolismSnapshot[];
  },
};

/** Repository for Skills. */
/** Linha bruta da tabela skills (snake_case — formato real retornado pelo SQLite). */
export interface SkillRow {
  id: number;
  session_id: string;
  name: string;
  description: string;
  success_rate: number; // 0..1
  usage_count: number;
  confidence: number; // 0..1
  last_updated: number;
}
export interface Skill {
  name: string;
  description: string;
  successRate: number; // 0..1
  usageCount: number;
  confidence: number; // 0..1
}
export interface SkillEntry {
  name: string;
  description: string;
  successes: number;
  failures: number;
  usageCount: number;
  lastUpdated: number;
}
export interface SkillsState {
  byName: Map<string, SkillEntry>;
}
export function createSkillsState(): SkillsState {
  return { byName: new Map<string, SkillEntry>() };
}
export function getSkills(state: SkillsState): Skill[] {
  return Array.from(state.byName.values()).map(entry => ({
    name: entry.name,
    description: entry.description,
    successRate: entry.usageCount > 0 ? entry.successes / entry.usageCount : 0,
    usageCount: entry.usageCount,
    confidence: 1 / (1 + Math.exp(-entry.usageCount + 3)),
  }));
}
export function updateSkill(
  state: SkillsState,
  capability: string,
  success: boolean,
  description: string,
): void {
  const entry = state.byName.get(capability) ?? {
    name: capability,
    description,
    successes: 0,
    failures: 0,
    usageCount: 0,
    lastUpdated: 0,
  };
  entry.usageCount += 1;
  if (success) entry.successes += 1; else entry.failures += 1;
  entry.lastUpdated = Date.now();
  state.byName.set(capability, entry);
}
export const skillsRepo = {
  state: createSkillsState(),
  update(capability: string, success: boolean, description: string): void {
    updateSkill(skillsRepo.state, capability, success, description);
  },
  getSkills: getSkills,
  leastConfidentSkill(state: SkillsState, capability: string): Skill | null {
    const skills = getSkills(state).filter(s => s.name === capability);
    if (skills.length === 0) return null;
    return skills.reduce((least, current) => current.confidence < least.confidence ? current : least);
  },
  create(input: { session_id: string; name: string; description: string; success_rate: number; usage_count: number; confidence: number; last_updated: number }): SkillRow {
    const db = driver();
    const stmt = db.prepare(`
      INSERT INTO skills (session_id, name, description, success_rate, usage_count, confidence, last_updated)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const now = Math.floor(Date.now() / 1000);
    const result = stmt.run(
      input.session_id,
      input.name,
      input.description,
      input.success_rate,
      input.usage_count,
      input.confidence,
      input.last_updated ?? now,
    );
    return this.getById(result.lastInsertRowid as number)!;
  },
  getById(id: number): SkillRow | null {
    const db = driver();
    return db.prepare("SELECT * FROM skills WHERE id = ?").get(id) as SkillRow | null;
  },
  getBySession(sessionId: string, limit = 50): SkillRow[] {
    const db = driver();
    return db.prepare("SELECT * FROM skills WHERE session_id = ? ORDER BY last_updated DESC LIMIT ?").all(sessionId, limit) as SkillRow[];
  },
};

/** Repository for Strategy Scores. */
/** Linha bruta da tabela strategy_scores (snake_case — formato real do SQLite). */
export interface StrategyScoreRow {
  id: number;
  session_id: string;
  strategy: string;
  success_rate: number; // 0..1
  avg_cost: number;
  avg_time: number; // ms
  sample_count: number;
  last_updated: number;
}
export interface StrategyScore {
  strategy: string; // 'single_agent' | 'multi_agent' | 'autonomous' | 'no_execution'
  successRate: number; // 0..1
  avgCost: number;
  avgTime: number; // ms
  sampleCount: number;
}
export interface StrategyCounters {
  strategy: string;
  successes: number;
  failures: number;
  totalCost: number;
  totalDuration: number;
  sampleCount: number;
}
export interface StrategyState {
  byStrategy: Map<string, StrategyCounters>;
}
export function createStrategyState(): StrategyState {
  return { byStrategy: new Map<string, StrategyCounters>() };
}
export function recordStrategyOutcome(
  state: StrategyState,
  strategy: string,
  success: boolean,
  costUsd: number,
  durationMs: number,
): void {
  const counters = state.byStrategy.get(strategy) || {
    strategy,
    successes: 0,
    failures: 0,
    totalCost: 0,
    totalDuration: 0,
    sampleCount: 0,
  };
  counters.successes += success ? 1 : 0;
  counters.failures += success ? 0 : 1;
  counters.totalCost += costUsd;
  counters.totalDuration += durationMs;
  counters.sampleCount += 1;
  state.byStrategy.set(strategy, counters);
}
export function scoreStrategies(state: StrategyState): StrategyScore[] {
  return Array.from(state.byStrategy.entries()).map(([strategy, counters]) => ({
    strategy,
    successRate: counters.successes / counters.sampleCount,
    avgCost: counters.totalCost / counters.sampleCount,
    avgTime: counters.totalDuration / counters.sampleCount,
    sampleCount: counters.sampleCount,
  })).sort((a, b) => (b.successRate - a.successRate) || (b.avgCost - a.avgCost));
}
export function bestStrategy(state: StrategyState, minSamples: number): string | null {
  const scored = scoreStrategies(state).filter(s => s.sampleCount >= minSamples);
  return scored.length > 0 ? scored[0]!.strategy : null;
}
export const strategyScoresRepo = {
  state: createStrategyState(),
  recordOutcome(strategy: string, success: boolean, costUsd: number, durationMs: number): void {
    recordStrategyOutcome(this.state, strategy, success, costUsd, durationMs);
  },
  getBySession(_minSamples = 1): StrategyScore[] {
    return scoreStrategies(this.state);
  },
  create(input: { session_id: string; strategy: string; success_rate: number; avg_cost: number; avg_time: number; sample_count: number; last_updated: number }): StrategyScore {
    const db = driver();
    const stmt = db.prepare(`
      INSERT INTO strategy_scores (session_id, strategy, success_rate, avg_cost, avg_time, sample_count, last_updated)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      input.session_id,
      input.strategy,
      input.success_rate,
      input.avg_cost,
      input.avg_time,
      input.sample_count,
      input.last_updated,
    );
    return this.getById(result.lastInsertRowid as number)!;
  },
  getById(id: number): StrategyScore | null {
    const db = driver();
    return db.prepare("SELECT * FROM strategy_scores WHERE id = ?").get(id) as StrategyScore | null;
  },
  getBySessionId(sessionId: string, limit = 50): StrategyScoreRow[] {
    const db = driver();
    return db.prepare("SELECT * FROM strategy_scores WHERE session_id = ? ORDER BY last_updated DESC LIMIT ?").all(sessionId, limit) as StrategyScoreRow[];
  },
};

/** Repository for Reflections. */
export interface ReflectionRecord {
  id: number;
  session_id: string;
  episode_id: number | null;
  task: string;
  plan_worked: number; // 0|1
  failed_step: string | null;
  improvement_suggestion: string | null;
  missing_knowledge: string | null;
  lessons: string; // JSON array
  created_at: number;
}
export interface ReflectionInput {
  session_id: string;
  episode_id: number | null;
  task: string;
  plan_worked: number; // 0|1
  failed_step: string | null;
  improvement_suggestion: string | null;
  missing_knowledge: string | null;
  lessons: string[];
}
export const reflectionsRepo = {
  create(input: ReflectionInput): ReflectionRecord {
    const db = driver();
    const stmt = db.prepare(`
      INSERT INTO reflections (session_id, episode_id, task, plan_worked, failed_step, improvement_suggestion, missing_knowledge, lessons, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const now = Math.floor(Date.now() / 1000);
    const result = stmt.run(
      input.session_id,
      input.episode_id ?? null,
      input.task,
      input.plan_worked,
      input.failed_step ?? null,
      input.improvement_suggestion ?? null,
      input.missing_knowledge ?? null,
      JSON.stringify(input.lessons),
      now,
    );
    return this.getById(result.lastInsertRowid as number)!;
  },
  getById(id: number): ReflectionRecord | null {
    const db = driver();
    return db.prepare("SELECT * FROM reflections WHERE id = ?").get(id) as ReflectionRecord | null;
  },
  getBySession(sessionId: string, limit = 20): ReflectionRecord[] {
    const db = driver();
    return db.prepare("SELECT * FROM reflections WHERE session_id = ? ORDER BY created_at DESC LIMIT ?").all(sessionId, limit) as ReflectionRecord[];
  },
};