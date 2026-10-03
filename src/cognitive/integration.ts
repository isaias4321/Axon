/**
 * Fase 9 — Integração com o Autonomous Agent.
 *
 * Conecta o CognitiveRouter ao fluxo real de executeTask()/runAutonomous().
 * O router é acionado quando uma tarefa exige uma capacidade especializada.
 */

import type { CognitiveCell, CellOutput, CognitiveMemory } from "./types.js";
import type { TaskProfile } from "../adaptive/taskAnalyzer.js";
import { CognitiveRouter, type RoutingContext } from "./router.js";
import { createCognitiveMemory } from "./memory.js";
import { ResearchCell } from "./cells/research.js";
import { DebugCell } from "./cells/debug.js";
import { PlanningCell } from "./cells/planning.js";
import { CodeReviewCell } from "./cells/code-review.js";
import { ConfigCell } from "./cells/config.js";
import { ValidationCell } from "./cells/validation.js";
import { RecoveryCell } from "./cells/recovery.js";

/**
 * Resultado da integração cognitiva consumível pelo Agent runtime.
 * Reflete o que o `CognitiveRouter` produziu para uma tarefa.
 */
export interface CognitiveIntegrationResult {
  /** Se o router foi de fato acionado (false => caiu no fluxo padrão do agente). */
  routerUsed: boolean;
  /** Classificação de intenção (presente quando `routerUsed` é true). */
  classification?: {
    primaryCellType: string;
    secondaryCellTypes: string[];
    confidence: number;
  };
  /** Resultados (data) de cada célula executada, por id de célula. */
  cellResults: Map<string, CellOutput>;
  /** Se todas as células completaram sem erro. */
  allSuccessful: boolean;
  /** Mensagens de erro agregadas (se houver). */
  errors: string[];
  /** Número de mensagens trocadas no barramento. */
  messagesCount: number;
  /** Id da tarefa associada. */
  taskId: string;
}

/**
 * Constrói as células cognitivas padrão.
 */
export function createDefaultCognitiveCells(): CognitiveCell[] {
  return [
    new ResearchCell(),
    new DebugCell(),
    new PlanningCell(),
    new CodeReviewCell(),
    new ConfigCell(),
    new ValidationCell(),
    new RecoveryCell(),
  ];
}

/**
 * Cria o CognitiveRouter completo com células padrão e memória compartilhada.
 */
export function createCognitiveSystem(
  options?: {
    sessionId?: string;
    fsRoot?: string;
  }
): {
  router: CognitiveRouter;
  memory: CognitiveMemory;
} {
  const sessionId = options?.sessionId ?? "default";
  const fsRoot = options?.fsRoot ?? process.env.DATA_DIR ?? "~/.axon";

  const memory = createCognitiveMemory({ sessionPrefix: `cognitive:${sessionId}` });

  const router = new CognitiveRouter({
    cells: createDefaultCognitiveCells(),
    cognitiveMemory: memory,
    defaultBudgets: {
      maxTokens: 50000,
      maxDurationMs: 60000,
      maxToolCalls: 20,
      maxCostUsd: 0.10,
    },
    defaultSandbox: {
      fsRoot,
      allowedTools: ["filesystem", "shell", "http"],
      allowShell: true,
      allowHttp: true,
      allowedEnvVars: [],
    },
    enableParallelDispatch: true,
    interCellTimeoutMs: 30000,
    maxParallelCells: 3,
  });

  return { router, memory };
}

/**
 * Constrói RoutingContext a partir de TaskProfile.
 */
export function buildRoutingContext(
  task: string,
  profile: TaskProfile,
  sessionId: string,
  memory: CognitiveMemory,
  options?: {
    budgets?: Partial<RoutingContext["budgets"]>;
    sandboxConfig?: Partial<RoutingContext["sandboxConfig"]>;
  }
): RoutingContext {
  const taskId = `${sessionId}:${Date.now()}:${Math.random().toString(36).substring(2, 8)}`;

  return {
    sessionId,
    taskId,
    taskProfile: {
      capabilities: profile.capabilities,
      category: profile.category,
      complexity: profile.complexity,
    },
    cognitiveMemory: memory,
    budgets: {
      maxTokens: 50000,
      maxDurationMs: 60000,
      maxToolCalls: 20,
      maxCostUsd: 0.10,
      ...(options?.budgets || {}),
    },
    sandboxConfig: {
      fsRoot: process.env.DATA_DIR ?? "~/.axon",
      allowedTools: ["filesystem", "shell", "http"],
      allowShell: true,
      allowHttp: true,
      allowedEnvVars: [],
      ...(options?.sandboxConfig || {}),
    },
    availableTools: ["filesystem", "shell", "http"],
  };
}

/**
 * Roteia uma tarefa via CognitiveRouter.
 *
 * Decide se usa o router (quando a tarefa exige capacidade especializada)
 * ou delega de volta ao agente autônomo padrão (quando não).
 */
export async function routeWithCognitiveSystem(
  task: string,
  profile: TaskProfile,
  sessionId: string,
  options?: {
    cognitiveMemory?: CognitiveMemory;
    forceRouter?: boolean;
    budgets?: Partial<RoutingContext["budgets"]>;
    sandboxConfig?: Partial<RoutingContext["sandboxConfig"]>;
  }
): Promise<CognitiveIntegrationResult> {
  const memory = options?.cognitiveMemory ?? createCognitiveMemory({ sessionPrefix: `cognitive:${sessionId}` });

  // O router usa a MESMA memória compartilhada que as células recebem no
  // contexto. (Bug corrigido: antes o router era criado via createCognitiveSystem
  // com memória interna própria, divergindo da `memory` passada às células,
  // o que quebrava o CognitiveContext compartilhado.)
  const router = new CognitiveRouter({
    cells: createDefaultCognitiveCells(),
    cognitiveMemory: memory,
    defaultBudgets: {
      maxTokens: 50000,
      maxDurationMs: 60000,
      maxToolCalls: 20,
      maxCostUsd: 0.10,
    },
    defaultSandbox: {
      fsRoot: process.env.DATA_DIR ?? "~/.axon",
      allowedTools: ["filesystem", "shell", "http"],
      allowShell: true,
      allowHttp: true,
      allowedEnvVars: [],
    },
    enableParallelDispatch: true,
    interCellTimeoutMs: 30000,
    maxParallelCells: 3,
  });

  const context = buildRoutingContext(task, profile, sessionId, memory, {
    budgets: options?.budgets,
    sandboxConfig: options?.sandboxConfig,
  });

  // Verificar se a tarefa se beneficia do router
  const classification = await router.classifyIntent(task, context);
  const shouldUseRouter = options?.forceRouter ||
    classification.confidence >= 0.5 ||
    classification.secondaryCellTypes.length > 0;

  if (!shouldUseRouter) {
    return {
      routerUsed: false,
      cellResults: new Map<string, CellOutput>(),
      allSuccessful: true,
      errors: [],
      messagesCount: 0,
      taskId: context.taskId,
    };
  }

  // Executar via router
  const result = await router.route(task, context);

  return {
    routerUsed: true,
    classification: {
      primaryCellType: classification.primaryCellType,
      secondaryCellTypes: classification.secondaryCellTypes,
      confidence: classification.confidence,
    },
    cellResults: result.results,
    allSuccessful: result.allSuccessful,
    errors: result.errors.map(e => e.message),
    messagesCount: result.messages.length,
    taskId: context.taskId,
  };
}

/**
 * Convierte o resultado cognitivo numa forma serializable por JSON.
 *
 * `CognitiveIntegrationResult.cellResults` es un `Map`, que JSON.stringify
 * convierte en `{}` (vacio) — perdiendo el detalle por-célula en el wire.
 * Esta función lo transforma en un objeto plano `{ cellId: output }` sin
 * alterar la API interna (los tests internos siguen usando el Map).
 */
export function toSerializableCognitiveResult(
  result: CognitiveIntegrationResult
): Record<string, unknown> {
  const cellResults: Record<string, CellOutput> = {};
  for (const [cellId, output] of result.cellResults) {
    cellResults[cellId] = output;
  }
  return { ...result, cellResults };
}

/**
 * Verifica si el CognitiveSystem está saludable.
 */
export async function healthCheckCognitiveSystem(): Promise<{
  healthy: boolean;
  cells: Array<{ id: string; healthy: boolean; checks: string[] }>;
  routerRegisteredCells: number;
}> {
  const cells = createDefaultCognitiveCells();
  const healthResults: Array<{ id: string; healthy: boolean; checks: string[] }> = [];

  for (const cell of cells) {
    const health = await cell.health();
    healthResults.push({
      id: cell.id,
      healthy: health.healthy,
      checks: health.checks.map(c => `${c.name}: ${c.status}`),
    });
  }

  const router = createCognitiveSystem().router;

  return {
    healthy: healthResults.every(r => r.healthy),
    cells: healthResults,
    routerRegisteredCells: router.listCells().length,
  };
}