/**
 * Fase 7 — Self Evolution Layer (Shared Types).
 *
 * Tipos compartilhados entre os módulos de evolução.
 */

/**
 * Sinal de curiosidade gerado pelo Curiosity Engine.
 */
export interface CuriositySignal {
  /** Se deve iniciar exploração. */
  shouldExplore: boolean;
  /** Razão legível (português, operacional). */
  reason: string;
  /** Prioridade numérica (0..1) para ranking. */
  priority: number;
  /** Área de conhecimento sugerida (ex: "planejamento", "raciocinio"). */
  suggestedKnowledge: string;
}

/** Estado interno do Curiosity Engine. */
export interface CuriosityState {
  /** Histórico de sinais por assinatura de tarefa. */
  signalHistory: Map<string, number>;
  /** Últimas N assinaturas de tarefa vistas (para detecção de repetição). */
  recentTasks: string[];
}

/** Tipos de objetivo interno. */
export type GoalType = "improve" | "learn" | "optimize";

/** Objetivo interno gerado a partir de sinais de curiosidade. */
export interface Goal {
  id: string;
  description: string;
  priority: number; // 0..1
  type: GoalType;
}

/** Estado metabólico (energético) do agente. */
export interface EnergyState {
  /** Tokens restantes no orçamento. */
  tokensAvailable: number;
  /** Orçamento USD restante. */
  budgetAvailable: number;
  /** Score de eficiência (0..1) — média móvel de sucesso/custo. */
  efficiencyScore: number;
  /** Nível de risco: low | medium | high. */
  riskLevel: "low" | "medium" | "high";
}

/** Níveis de custo/qualidade do modelo. */
export type ModelTier = "cheap" | "balanced" | "expensive";

/** Escolha de modelo sugerida pelo Metabolism. */
export interface ModelChoice {
  model: string;
  provider: string;
  tier: ModelTier;
  reason: string;
}

/** Snapshot interno de estado metabólico. */
export interface EnergySnapshot {
  tokensAvailable: number;
  budgetAvailable: number;
  efficiencyScore: number;
  riskLevel: "low" | "medium" | "high";
  takenAt: number;
}

/** Estado metabólico acumulado. */
export interface MetabolismState {
  /** Histórico de snapshots de energia. */
  snapshots: EnergySnapshot[];
  /** Histórico de eficiência: sucessos / custo total. */
  efficiencyHistory: { success: number; cost: number }[];
}

/** Habilidade adquirida pelo agente. */
export interface Skill {
  name: string;
  description: string;
  successRate: number; // 0..1
  usageCount: number;
  confidence: number; // 0..1
}

/** Contadores internos de habilidade (para persistência/cálculo). */
export interface SkillEntry {
  name: string;
  description: string;
  successes: number;
  failures: number;
  usageCount: number;
  lastUpdated: number;
}

/** Estado de aquisição de habilidades. */
export interface SkillsState {
  byName: Map<string, SkillEntry>;
}

/** Score de uma estratégia. */
export interface StrategyScore {
  strategy: string;
  successRate: number; // 0..1
  avgCost: number;
  avgTime: number;
  sampleCount: number;
}

/** Contadores internos de estratégia. */
export interface StrategyCounters {
  strategy: string;
  successes: number;
  failures: number;
  totalCost: number;
  totalDuration: number;
  sampleCount: number;
}

/** Estado de evolution de estratégias. */
export interface StrategyState {
  byStrategy: Map<string, StrategyCounters>;
}

/** Registro de auto-reflexão pós-execução. */
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

/** Input para persistir reflexão. */
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

/** Objetivo interno. */
export interface Goal {
  id: string;
  description: string;
  priority: number;
  type: GoalType;
}