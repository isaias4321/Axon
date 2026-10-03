/**
 * Fase 9 — Cognitive Router.
 *
 * Responsável por receber tarefas, classificar intenções,
 * selecionar células adequadas e executar dispatch (single ou multi-cell).
 */

import type {
  CognitiveCell,
  CellInput,
  CellOutput,
  CellExecutionContext,
  CellMessage,
  CellId,
  CellType,
  CognitiveMemory,
  CellError,
  MultiCellDispatchResult,
  CognitiveRouterConfig,
  CanHandleResult,
  CellToolRegistry,
} from "./types.js";
import type { TaskCapability, TaskCategory, TaskComplexity } from "../adaptive/taskAnalyzer.js";
import { createCognitiveToolRegistry } from "./tools/index.js";
import { DefaultCellSupervisor } from "./supervisor.js";

/**
 * Resultado da classificação de intenção.
 */
export interface IntentClassification {
  /** Tipo de célula principal sugerida. */
  primaryCellType: CellType;
  /** Confiança da classificação (0-1). */
  confidence: number;
  /** Tipos de células adicionais para tarefas compostas. */
  secondaryCellTypes: CellType[];
  /** Entidades extraídas da tarefa. */
  entities: ExtractedEntity[];
  /** Raciocínio da classificação. */
  reasoning: string;
}

/**
 * Entidade extraída do input do usuário.
 */
export interface ExtractedEntity {
  type: "file_path" | "error_code" | "config_key" | "technology" | "concept" | "cell_type";
  value: string;
  confidence: number;
}

/**
 * Contexto de roteamento para execução.
 */
export interface RoutingContext {
  sessionId: string;
  taskId: string;
  taskProfile: {
    capabilities: string[];
    category: string;
    complexity: string;
  };
  cognitiveMemory: CognitiveMemory;
  budgets: {
    maxTokens: number;
    maxDurationMs: number;
    maxToolCalls: number;
    maxCostUsd: number;
  };
  sandboxConfig: {
    fsRoot: string;
    allowedTools: string[];
    allowShell: boolean;
    allowHttp: boolean;
    allowedEnvVars: string[];
  };
  availableTools: string[];
}

/**
 * Resultado do dispatch de uma única célula.
 */
export interface SingleCellDispatchResult {
  cellId: CellId;
  cellType: CellType;
  output: CellOutput;
  messages: CellMessage[];
}

/**
 * Cognitive Router principal.
 */
export class CognitiveRouter {
  private cells: Map<CellType, CognitiveCell> = new Map();
  private cellInstances: CognitiveCell[] = [];
  private cognitiveMemory: CognitiveMemory;
  private config: CognitiveRouterConfig;
  private messageBus: CellMessage[] = [];
  private toolRegistry: CellToolRegistry;

  constructor(config: CognitiveRouterConfig) {
    this.config = config;
    this.cognitiveMemory = config.cognitiveMemory;
    this.toolRegistry = createCognitiveToolRegistry();

    // Registra células do array de config
    if (config.cells && Array.isArray(config.cells)) {
      for (const cell of config.cells) {
        this.registerCell(cell);
      }
    }
  }

  /**
   * Registra uma célula no router.
   */
  registerCell(cell: CognitiveCell): void {
    this.cells.set(cell.type, cell);
    this.cellInstances.push(cell);
  }

  /**
   * Obtém uma célula por tipo.
   */
  getCell(type: CellType): CognitiveCell | undefined {
    return this.cells.get(type);
  }

  /**
   * Lista todas as células registradas.
   */
  listCells(): CognitiveCell[] {
    return this.cellInstances;
  }

  /**
   * Classifica a intenção do usuário.
   */
  async classifyIntent(
    task: string,
    _context: RoutingContext
  ): Promise<IntentClassification> {
    const lowerTask = task.toLowerCase();
    const entities: ExtractedEntity[] = [];

    // Extração de entidades básicas
    this.extractEntities(task, entities);

    // Classificação baseada em palavras-chave e entidades
    const scores = new Map<CellType, number>();

    // Research patterns
    const researchKeywords = [
      "pesquisar", "buscar", "research", "web", "documentação", "como fazer",
      "implementar", "arquitetura", "como funciona", "entender"
    ];

    // Debug indicators
    const debugKeywords = [
      "erro", "falha", "429", "rate limit", "timeout", "depurar",
      "investigar", "o que aconteceu", "corrigir", "consertar"
    ];

    // Planning indicators
    const planningKeywords = [
      "planejar", "planeje", "planeja", "planeja", "roadmap", "próximos passos",
      "estratégia", "arquitetura", "refatorar", "migrar", "implementar",
      "criar", "desenhar", "design", "estruturar", "organizar",
      "correção", "correcao", "fix"
    ];

    // Code review indicators
    const reviewKeywords = [
      "revisar", "refatorar", "auditar", "validar", "verificar",
      "security", "segurança", "performance", "otimizar",
      "simplificar", "limpar", "refator"
    ];

    // Config indicators
    const configKeywords = [
      "configurar", "config", "setting", "variável", "environment",
      "rate limit", "redis", "cache", "chave", "api key",
      "timeout", "limit", "threshold"
    ];

    // Validation indicators (específicas, sem conflitar com review "verificar")
    const validationKeywords = [
      "validação", "validar resultado", "valida o resultado", "confirmar resultado",
      "garantir que", "checar se", "validação final"
    ];

    // Recovery indicators (específicas de falha/bloqueio)
    const recoveryKeywords = [
      "recovery", "replanning", "nova estratégia", "plano alternativo",
      "estagnação", "sem progresso", "loop infinito", "travou", "bloqueado",
      "tenta de novo", "recuperar de falha", "recuperação"
    ];

    // Score por palavras-chave
    for (const keyword of researchKeywords) {
      if (lowerTask.includes(keyword)) {
        scores.set("research", (scores.get("research") || 0) + 1);
      }
    }
    for (const keyword of debugKeywords) {
      if (lowerTask.includes(keyword)) {
        scores.set("debug", (scores.get("debug") || 0) + 1);
      }
    }
    for (const keyword of planningKeywords) {
      if (lowerTask.includes(keyword)) {
        scores.set("planning", (scores.get("planning") || 0) + 1);
      }
    }
    for (const keyword of reviewKeywords) {
      if (lowerTask.includes(keyword)) {
        scores.set("code_review", (scores.get("code_review") || 0) + 1);
      }
    }
    for (const keyword of configKeywords) {
      if (lowerTask.includes(keyword)) {
        scores.set("config", (scores.get("config") || 0) + 1);
      }
    }
    for (const keyword of validationKeywords) {
      if (lowerTask.includes(keyword)) {
        scores.set("validation", (scores.get("validation") || 0) + 1);
      }
    }
    for (const keyword of recoveryKeywords) {
      if (lowerTask.includes(keyword)) {
        scores.set("recovery", (scores.get("recovery") || 0) + 1);
      }
    }

    // Boost por entidades extraídas
    for (const entity of entities) {
      if (entity.type === "error_code") scores.set("debug", (scores.get("debug") || 0) + 3);
      if (entity.type === "config_key") scores.set("config", (scores.get("config") || 0) + 1);
      if (entity.type === "file_path") scores.set("code_review", (scores.get("code_review") || 0) + 2);
      if (entity.type === "technology") scores.set("research", (scores.get("research") || 0) + 1);
    }

    // Boost por verbos de ação (pesquisar/planejar/revisar)
    const actionBoost = new Map<CellType, number>();
    if (researchKeywords.some(k => lowerTask.includes(k))) {
      actionBoost.set("research", 4);
    }
    if (planningKeywords.some(k => lowerTask.includes(k))) {
      actionBoost.set("planning", 4);
    }
    if (reviewKeywords.some(k => lowerTask.includes(k))) {
      actionBoost.set("code_review", 4);
    }
    for (const [type, boost] of actionBoost) {
      scores.set(type, (scores.get(type) || 0) + boost);
    }

    // Se há entidades de error_code, debug tem prioridade
    if (entities.some(e => e.type === "error_code")) {
      scores.set("debug", (scores.get("debug") || 0) + 2);
    }

    // Determinar primária e secundárias
    const sorted = Array.from(scores.entries()).sort((a, b) => b[1] - a[1]);

    const primaryCellType = sorted[0]?.[0] || "research";
    const primaryScore = sorted[0]?.[1] || 0;
    const totalScore = Array.from(scores.values()).reduce((a, b) => a + b, 0) || 1;

    const secondaryCellTypes = sorted
      .slice(1)
      .filter(([, score]) => score >= Math.max(1, primaryScore * 0.5))
      .map(([type]) => type);

    // Verificar se células estão disponíveis
    const availablePrimary = this.cells.has(primaryCellType);
    const availableSecondaries = secondaryCellTypes.filter(t => this.cells.has(t));

    const confidence = availablePrimary
      ? Math.min(0.95, primaryScore / totalScore + 0.2)
      : 0.3;

    return {
      primaryCellType: availablePrimary ? primaryCellType : "research",
      confidence,
      secondaryCellTypes: availableSecondaries,
      entities,
      reasoning: `Classificado como ${primaryCellType} (score: ${primaryScore}). Entidades: ${entities.map(e => `${e.type}=${e.value}`).join(", ") || "nenhuma"}. Secundárias: ${availableSecondaries.join(", ") || "nenhuma"}`,
    };
  }

  /**
   * Extrai entidades do texto da tarefa.
   */
  private extractEntities(task: string, entities: ExtractedEntity[]): void {
    const lowerTask = task.toLowerCase();

    // Error codes (HTTP status, etc.)
    const errorCodeMatch = task.match(/\b(4\d{2}|5\d{2})\b/g);
    if (errorCodeMatch) {
      for (const code of errorCodeMatch) {
        entities.push({ type: "error_code", value: code, confidence: 0.9 });
      }
    }

    // Config keys (rate_limit, redis_url, etc.)
    const configKeys = ["rate_limit", "redis", "cache", "timeout", "api_key", "model", "provider"];
    for (const key of configKeys) {
      if (lowerTask.includes(key)) {
        entities.push({ type: "config_key", value: key, confidence: 0.8 });
      }
    }

    // File paths
    const filePathMatch = task.match(/[\w/\\.-]+\.(ts|js|json|md|yml|yaml)/g);
    if (filePathMatch) {
      for (const path of filePathMatch) {
        entities.push({ type: "file_path", value: path, confidence: 0.85 });
      }
    }

    // Technologies
    const techs = ["typescript", "javascript", "node", "redis", "postgres", "docker", "kubernetes", "aws", "gcp", "azure"];
    for (const tech of techs) {
      if (lowerTask.includes(tech)) {
        entities.push({ type: "technology", value: tech, confidence: 0.7 });
      }
    }

    // Cell types mencionados explicitamente
    const cellTypes: CellType[] = ["research", "debug", "planning", "code_review", "config"];
    for (const ct of cellTypes) {
      if (lowerTask.includes(ct.replace("_", " ")) || lowerTask.includes(ct)) {
        entities.push({ type: "cell_type", value: ct, confidence: 0.95 });
      }
    }
  }

  /**
   * Roteia uma tarefa completa (interface principal).
   */
  async route(task: string, context: RoutingContext): Promise<MultiCellDispatchResult> {
    const classification = await this.classifyIntent(task, context);

    // Armazenar classificação na memória
    await this.cognitiveMemory.set(`intent:${context.taskId}`, {
      value: { ...classification },
      cellId: "router",
      cellType: "research", // cellType do router: usa o tipo da primária
      timestamp: Date.now(),
      sessionId: context.sessionId,
      taskId: context.taskId,
      tags: ["intent", "classification"],
      version: 1,
    });

    // Dispatch baseado no número de células
    const cellTypes = [classification.primaryCellType, ...classification.secondaryCellTypes]
      .filter(t => this.cells.has(t));

    if (cellTypes.length <= 1) {
      const result = await this.dispatchSingle(cellTypes[0] || "research", task, context);
      return {
        results: new Map([[result.cellId, result.output]]),
        messages: result.messages,
        allSuccessful: result.output.success,
        errors: result.output.error ? [result.output.error] : [],
      };
    }

    return this.dispatchMultiple(task, context);
  }

  /**
   * Dispatch para múltiplas células (paralelo ou sequencial).
   */
  private async dispatchMultiple(
    task: string,
    context: RoutingContext
  ): Promise<MultiCellDispatchResult> {
    const classification = await this.classifyIntent(task, context);
    const cellTypes = [classification.primaryCellType, ...classification.secondaryCellTypes]
      .filter(t => this.cells.has(t));

    const results = new Map<CellId, CellOutput>();
    const allMessages: CellMessage[] = [];
    const errors: CellError[] = [];

    for (const cellType of cellTypes) {
      try {
        const result = await this.dispatchSingle(cellType, task, context);
        results.set(result.cellId, result.output);
        allMessages.push(...result.messages);
        if (result.output.error) {
          errors.push(result.output.error);
        }
      } catch (error) {
        const cell = this.cells.get(cellType);
        const cellError: CellError = {
          code: "DISPATCH_ERROR",
          message: error instanceof Error ? error.message : String(error),
          recoverable: false,
        };
        errors.push(cellError);
        results.set(cell?.id || cellType, {
          success: false,
          error: cellError,
          metrics: { tokensUsed: 0, durationMs: 0, toolCalls: 0, costUsd: 0 },
          provenance: {
            cellId: cell?.id || cellType,
            cellType,
            timestamp: Date.now(),
            sessionId: context.sessionId,
            taskId: context.taskId,
            inputHash: "",
          },
        });
      }
    }

    return {
      results,
      messages: allMessages,
      allSuccessful: errors.length === 0,
      errors,
    };
  }

  /**
   * Dispatch para uma única célula.
   */
  private async dispatchSingle(
    cellType: CellType,
    task: string,
    context: RoutingContext
  ): Promise<SingleCellDispatchResult> {
    const cell = this.cells.get(cellType);
    if (!cell) {
      throw new Error(`Célula '${cellType}' não registrada`);
    }

    // Normaliza a task string para o payload estruturado esperado pela célula
    const cellInput = this.normalizeCellInput(cellType, task);

    // Fase 9.2 — supervisor REAL por despacho: permite que a célula solicite
    // outras células (requestCell) com ciclo/depth/budget/timeout garantidos.
    const supervisor = new DefaultCellSupervisor(
      (target) => this.cells.get(target),
      (target, request) => this.normalizeCellInput(target, request),
      { maxDepth: 3, maxCellCalls: 8, timeoutMs: this.config.interCellTimeoutMs },
      (toCellType, fromCellId, message, payload) => {
        void this.pushMessage({
          id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          fromCellId,
          fromCellType: cellType,
          toCellId: null,
          toCellType,
          messageType: "context_share",
          payload: { message, ...(payload as Record<string, unknown> | undefined) },
          timestamp: Date.now(),
          correlationId: context.taskId,
          requiresResponse: false,
        });
      }
    );

    // Verifica se a célula pode lidar
    const cellContext = this.buildCellContext(context);
    const canHandleResult = await cell.canHandle(cellInput, cellContext);

    if (!canHandleResult.canHandle) {
      throw new Error(`Célula ${cellType} não pode lidar com este input: ${canHandleResult.reason}`);
    }

    // Executa a célula com supervisor disponível no contexto (F9.2)
    const output = await cell.execute(cellInput, {
      ...cellContext,
      supervisor,
      delegationChain: [],
    });

    return {
      cellId: cell.id,
      cellType,
      output,
      messages: [], // Será preenchido se houver comunicação
    };
  }

  /** Fase 9.2 — registra mensagem no barramento inter-cell. */
  private async pushMessage(message: CellMessage): Promise<void> {
    this.messageBus.push(message);
  }

  /**
   * Converte a task/input bruto no payload estruturado esperado por cada
   * tipo de célula (ex.: DebugCell espera errorMessage/errorCode, ResearchCell
   * espera query, PlanningCell espera goal, etc.).
   */
  private normalizeCellInput(cellType: CellType, input: unknown): CellInput {
    // Se já é CellInput estruturado, retorna direto
    if (input && typeof input === "object" && "type" in input && "payload" in input) {
      return input as unknown as CellInput;
    }

    const raw = typeof input === "string" ? input : String(input);

    switch (cellType) {
      case "research":
        return {
          type: "research_query",
          payload: { query: raw, focus: "code", depth: "thorough" },
        };
      case "debug": {
        const errorCode = this.extractErrorCode(raw);
        return {
          type: "debug_error",
          payload: {
            errorMessage: raw,
            errorCode,
            stackTrace: undefined,
            context: "auto",
            focus: "all",
          },
        };
      }
      case "planning":
        return {
          type: "plan_request",
          payload: { goal: raw, context: "general", constraints: [], horizon: "medium" },
        };
      case "code_review":
        return {
          type: "code_review",
          payload: { task: raw, lenses: ["correctness", "security", "performance", "simplification"] },
        };
      case "config":
        return {
          type: "config_action",
          payload: { action: "view", target: "all", dryRun: true },
        };
      case "validation":
        return {
          type: "validation",
          payload: { objective: raw, result: null, mode: "presence" },
        };
      case "recovery":
        return {
          type: "recovery",
          payload: { failure: raw, consecutiveFailures: 1, maxAttempts: 3 },
        };
      default:
        return { type: cellType, payload: raw };
    }
  }

  private extractErrorCode(task: string): string | undefined {
    const match = task.match(/\b(4\d{2}|5\d{2})\b/);
    return match?.[0];
  }

  /**
   * Verifica se a célula pode lidar com o input.
   */
  private async canHandle(
    cellType: CellType,
    input: unknown,
    context: RoutingContext
  ): Promise<CanHandleResult> {
    const cell = this.cells.get(cellType);
    if (!cell) {
      return { canHandle: false, confidence: 0, reason: "Célula não registrada", matchedCapabilities: [] };
    }

    // Verifica se a célula pode lidar com o input
    const canHandleResult = await cell.canHandle(
      { type: cellType, payload: null },
      this.buildCellContext(context)
    );

    return {
      canHandle: canHandleResult.canHandle,
      confidence: canHandleResult.confidence,
      reason: canHandleResult.reason,
      matchedCapabilities: canHandleResult.matchedCapabilities,
    };
  }

  /**
   * Constrói contexto de execução para célula.
   */
  private buildCellContext(context: RoutingContext): CellExecutionContext {
    return {
      sessionId: context.sessionId,
      taskId: context.taskId,
      taskProfile: {
        capabilities: context.taskProfile.capabilities as TaskCapability[],
        category: context.taskProfile.category as TaskCategory,
        complexity: context.taskProfile.complexity as TaskComplexity,
        text: "",
        hints: [],
        wordCount: 0,
        charCount: 0,
      },
      cognitiveMemory: context.cognitiveMemory,
      budgets: {
        maxTokens: context.budgets.maxTokens,
        maxDurationMs: context.budgets.maxDurationMs,
        maxToolCalls: context.budgets.maxToolCalls,
        maxCostUsd: context.budgets.maxCostUsd,
      },
      availableTools: context.availableTools,
      sandboxConfig: context.sandboxConfig,
      toolRegistry: this.toolRegistry,
    };
  }

  /**
   * Envia mensagem entre células (F9.1).
   */
  async sendMessage(message: CellMessage): Promise<void> {
    this.messageBus.push(message);
  }

  /**
   * Obtém mensagens do barramento.
   */
  getMessages(): CellMessage[] {
    return [...this.messageBus];
  }

  /**
   * Limpa barramento de mensagens.
   */
  clearMessages(): void {
    this.messageBus = [];
  }
}

/**
 * Factory para criar router configurado.
 */
export function createCognitiveRouter(
  cells: CognitiveCell[],
  cognitiveMemory: CognitiveMemory,
  options?: Partial<CognitiveRouterConfig>
): CognitiveRouter {
  const defaultBudgets = {
    maxTokens: 50000,
    maxDurationMs: 60000,
    maxToolCalls: 20,
    maxCostUsd: 0.10,
  };

  const defaultSandbox = {
    fsRoot: process.env.DATA_DIR ?? "~/.axon",
    allowedTools: ["filesystem", "shell", "http"],
    allowShell: true,
    allowHttp: true,
    allowedEnvVars: [],
  };

  const config: CognitiveRouterConfig = {
    cells,
    cognitiveMemory,
    defaultBudgets: options?.defaultBudgets ?? defaultBudgets,
    defaultSandbox: options?.defaultSandbox ?? defaultSandbox,
    enableParallelDispatch: options?.enableParallelDispatch ?? true,
    interCellTimeoutMs: options?.interCellTimeoutMs ?? 30000,
    maxParallelCells: options?.maxParallelCells ?? 3,
  };

  return new CognitiveRouter(config);
}