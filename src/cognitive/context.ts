/**
 * Fase 9.2 — Cognitive Context.
 *
 * Contexto compartilhado entre células cognitivas durante uma execução.
 * Permite que células troquem informações e mantenham estado durante uma execução.
 */

import type {
  CellType,
  CognitiveMemory,
  CognitiveMemoryEntry,
} from "./types.js";

/**
 * Célula "virtual" atribuída às entradas de contexto gravadas pelo sistema
 * (o contexto é escrito pelo router/integração, não por uma célula específica).
 */
const CONTEXT_CELL_TYPE: CellType = "research";

/**
 * Estado do contexto cognitivo compartilhado durante uma execução.
 */
export interface CognitiveContext {
  /** ID da sessão para isolamento. */
  sessionId: string;
  /** ID da tarefa original. */
  taskId: string;
  /** Intenção original da tarefa. */
  intent: string;
  /** Decisão de roteamento do router. */
  routingDecision: {
    primaryCellType: string;
    secondaryCellTypes: string[];
    confidence: number;
    entities: Array<{ type: string; value: string; confidence: number }>;
    reasoning: string;
  };
  /** Célula ativa atualmente. */
  activeCell: string;
  /** Célula que executou anteriormente. */
  previousCell: string | null;
  /** Findings acumulados da ResearchCell. */
  findings: Array<{
    sourceCell: string;
    sourceTool: string;
    timestamp: number;
    data: unknown;
  }>;
  /** Diagnóstico da DebugCell. */
  diagnosis: {
    errorType: string;
    rootCause: string;
    confidence: number;
    affectedComponents: string[];
    evidence: unknown[];
    suggestedFixes: Array<{ description: string; filesToChange: string[]; riskLevel: string; testingRequired: string[] }>;
    impact: string;
    relatedErrors: string[];
  } | null;
  /** Plano gerado pela PlanningCell. */
  plan: {
    goal: string;
    steps: Array<{
      id: string;
      title: string;
      description: string;
      dependencies: string[];
      estimatedEffort: "S" | "M" | "L" | "XL";
      priority: "critical" | "high" | "medium" | "low";
      suggestedFiles?: string[];
    }>;
    timeline: Array<{ name: string; items: string[]; duration: string; deliverables: string[] }>;
    risks: Array<{ description: string; likelihood: string; impact: string; mitigation: string }>;
    assumptions: string[];
    successCriteria: string[];
  } | null;
  /** Validação do resultado. */
  validation: {
    verdict: "pass" | "fail" | "warn";
    findings: Array<{ check: string; verdict: "pass" | "fail" | "warn"; detail?: string }>;
    canContinue: boolean;
    suggestedAction: "continue" | "retry" | "replan" | "abort";
    summary: string;
  } | null;
  /** Erros acumulados. */
  errors: Array<{
    cell: string;
    message: string;
    timestamp: number;
    recoverable: boolean;
  }>;
  /** Decisões tomadas durante a execução. */
  decisions: Array<{
    step: string;
    decision: string;
    reason: string;
    timestamp: number;
  }>;
  /** Resultados de tools. */
  toolResults: Array<{
    tool: string;
    input: unknown;
    output: unknown;
    success: boolean;
    timestamp: number;
    cell: string;
  }>;
  /** Metadados da execução. */
  metadata: {
    startTime: number;
    endTime?: number;
    currentCell: string;
    delegationDepth: number;
    toolCalls: number;
    totalTokens: number;
  };
}

type FindingsEntry = CognitiveContext["findings"][number];
type ErrorsEntry = CognitiveContext["errors"][number];
type DecisionsEntry = CognitiveContext["decisions"][number];
type ToolResultsEntry = CognitiveContext["toolResults"][number];

/**
 * Cria um novo contexto cognitivo vazio.
 */
export function createCognitiveContext(sessionId: string, taskId: string): CognitiveContext {
  return {
    sessionId,
    taskId,
    intent: "",
    routingDecision: {
      primaryCellType: "",
      secondaryCellTypes: [],
      confidence: 0,
      entities: [],
      reasoning: "",
    },
    activeCell: "",
    previousCell: null,
    findings: [],
    diagnosis: null,
    plan: null,
    validation: null,
    errors: [],
    decisions: [],
    toolResults: [],
    metadata: {
      startTime: Date.now(),
      endTime: undefined,
      currentCell: "",
      delegationDepth: 0,
      toolCalls: 0,
      totalTokens: 0,
    },
  };
}

/**
 * Chaves para armazenamento de dados no contexto cognitivo.
 */
export const CognitiveContextKeys = {
  FINDINGS: "findings",
  DIAGNOSIS: "diagnosis",
  PLAN: "plan",
  VALIDATION: "validation",
  ERRORS: "errors",
  DECISIONS: "decisions",
  TOOL_RESULTS: "toolResults",
  METADATA: "metadata",
  INTENT: "intent",
  ROUTING_DECISION: "routingDecision",
  ACTIVE_CELL: "activeCell",
  PREVIOUS_CELL: "previousCell",
  DELEGATION_DEPTH: "delegationDepth",
} as const;

/** Constrói a entrada padrão de memória para escritas de contexto. */
function contextEntry(value: unknown): CognitiveMemoryEntry {
  return {
    value,
    cellId: "context",
    cellType: CONTEXT_CELL_TYPE,
    timestamp: Date.now(),
    sessionId: "system",
    taskId: "context",
    tags: ["context"],
    version: 1,
  };
}

/**
 * Helper para ler dados do contexto cognitivo da memória compartilhada.
 */
export async function readCognitiveContext<T>(
  memory: CognitiveMemory,
  sessionId: string,
  key: string
): Promise<T | undefined> {
  const fullKey = `${sessionId}:${key}`;
  const entry = await memory.get(fullKey);
  return entry?.value as T | undefined;
}

/**
 * Helper para escrever dados no contexto cognitivo na memória compartilhada.
 */
export async function writeCognitiveContext(
  memory: CognitiveMemory,
  sessionId: string,
  key: string,
  value: unknown
): Promise<void> {
  const keyWithPrefix = `${sessionId}:${key}`;
  await memory.set(keyWithPrefix, contextEntry(value));
}

/**
 * Limpa o contexto cognitivo de uma sessão.
 */
export async function clearCognitiveContext(
  memory: CognitiveMemory,
  sessionId: string
): Promise<void> {
  const keys = [
    "findings",
    "diagnosis",
    "plan",
    "validation",
    "errors",
    "decisions",
    "toolResults",
    "metadata",
    "intent",
    "routingDecision",
    "activeCell",
    "previousCell",
    "delegationDepth",
  ];

  for (const key of keys) {
    await memory.delete(`${sessionId}:${key}`);
  }
}

/**
 * Contexto cognitivo compartilhado para uso durante execução de células.
 * Este é um wrapper que facilita leitura/escrita no CognitiveMemory.
 */
export class SharedCognitiveContext {
  private memory: CognitiveMemory;
  private sessionId: string;

  constructor(memory: CognitiveMemory, sessionId: string) {
    this.memory = memory;
    this.sessionId = sessionId;
  }

  async getFindings(): Promise<FindingsEntry[]> {
    return (await this.get<FindingsEntry[]>("findings")) || [];
  }

  async addFinding(sourceCell: string, sourceTool: string, data: unknown): Promise<void> {
    const findings = await this.getFindings();
    findings.push({ sourceCell, sourceTool, timestamp: Date.now(), data });
    await this.set("findings", findings);
  }

  async getDiagnosis(): Promise<CognitiveContext["diagnosis"] | undefined> {
    return this.get<CognitiveContext["diagnosis"]>("diagnosis");
  }

  async setDiagnosis(diagnosis: NonNullable<CognitiveContext["diagnosis"]>): Promise<void> {
    await this.set("diagnosis", diagnosis);
  }

  async getPlan(): Promise<CognitiveContext["plan"] | undefined> {
    return this.get<CognitiveContext["plan"]>("plan");
  }

  async setPlan(plan: NonNullable<CognitiveContext["plan"]>): Promise<void> {
    await this.set("plan", plan);
  }

  async getValidation(): Promise<CognitiveContext["validation"] | undefined> {
    return this.get<CognitiveContext["validation"]>("validation");
  }

  async setValidation(validation: NonNullable<CognitiveContext["validation"]>): Promise<void> {
    await this.set("validation", validation);
  }

  async addError(cell: string, message: string): Promise<void> {
    const errors = (await this.get<ErrorsEntry[]>("errors")) || [];
    const entry: ErrorsEntry = { cell, message, timestamp: Date.now(), recoverable: true };
    errors.push(entry);
    await this.set("errors", errors);
  }

  async addDecision(step: string, decision: string, reason: string): Promise<void> {
    const decisions = (await this.get<DecisionsEntry[]>("decisions")) || [];
    const entry: DecisionsEntry = { step, decision, reason, timestamp: Date.now() };
    decisions.push(entry);
    await this.set("decisions", decisions);
  }

  async addToolResult(
    tool: string,
    input: unknown,
    output: unknown,
    success: boolean,
    cell: string
  ): Promise<void> {
    const results = (await this.get<ToolResultsEntry[]>("toolResults")) || [];
    const entry: ToolResultsEntry = { tool, input, output, success, timestamp: Date.now(), cell };
    results.push(entry);
    await this.set("toolResults", results);
  }

  private async get<T>(key: string): Promise<T | undefined> {
    const entry = await this.memory.get(`${this.sessionId}:${key}`);
    return entry?.value as T | undefined;
  }

  private async set(key: string, value: unknown): Promise<void> {
    const entry = contextEntry(value);
    await this.memory.set(`${this.sessionId}:${key}`, {
      ...entry,
      sessionId: this.sessionId,
    });
  }
}