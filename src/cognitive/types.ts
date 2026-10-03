/**
 * Fase 9 — Cognitive Cells Core Types.
 *
 * Tipos compartilhados para o sistema de células cognitivas.
 * Integrado com a arquitetura existente (Fases 1-8).
 */

import type { TaskProfile } from "../adaptive/taskAnalyzer.js";

/**
 * Identificador único de uma célula cognitiva.
 */
export type CellId = string;

/**
 * Tipos de células cognitivas disponíveis.
 */
export type CellType =
  | "research"
  | "debug"
  | "planning"
  | "code_review"
  | "config"
  | "validation"
  | "recovery";

/**
 * Capacidades que uma célula pode declarar que suporta.
 */
export type CellCapability =
  | "code_search"
  | "web_search"
  | "error_analysis"
  | "log_analysis"
  | "root_cause_analysis"
  | "plan_generation"
  | "replanning"
  | "validation"
  | "recovery"
  | "code_review_correctness"
  | "code_review_security"
  | "code_review_performance"
  | "code_review_simplification"
  | "config_view"
  | "config_update"
  | "config_validate"
  | "config_diff"
  | "config_reset";

/**
 * Contrato mínimo de ToolRegistry usado pelas células.
 * Compatível com o DefaultToolRegistry da Fase 8.
 */
export interface CellToolRegistry {
  execute<TInput>(name: string, input: TInput): Promise<CellToolResult>;
  list(): string[];
  getHistory(): unknown[];
}

/**
 * Resultado de uma tool (mesma forma do ToolResult da F8).
 */
export interface CellToolResult {
  success: boolean;
  output: string | null;
  error: string | null;
  exitCode: number | null;
  durationMs: number;
  filesChanged?: string[];
  metadata: Record<string, unknown>;
}

/**
 * Contexto de execução passado para as células.
 */
export interface CellExecutionContext {
  /** ID da sessão para isolamento e rastreabilidade. */
  sessionId: string;
  /** ID da tarefa original. */
  taskId: string;
  /** Perfil da tarefa original (Fase 1). */
  taskProfile: TaskProfile;
  /** Memória cognitiva compartilhada. */
  cognitiveMemory: CognitiveMemory;
  /** Orçamentos de execução. */
  budgets: CellBudgets;
  /** Ferramentas disponíveis para a célula. */
  availableTools: string[];
  /** Configuração de sandbox/segurança. */
  sandboxConfig: SandboxConfig;
  /** ToolRegistry real da Fase 8 (filesystem, shell, http, grep). */
  toolRegistry?: CellToolRegistry;
  /** Supervisor para requisição de outras células (F9.2). */
  supervisor?: CellSupervisor;
  /**
   * Fase 9.2 — ancestral na cadeia de delegação (presente quando esta
   * execução foi solicitada por outra célula via supervisor).
   */
  parentCell?: {
    id: CellId;
    type: CellType;
    depth: number;
  };
  /**
   * Fase 9.2 — cadeia de tipos de células que levou até esta execução
   * (ex.: ["debug","research"]). Usada para detecção de ciclo.
   */
  delegationChain?: readonly CellType[];
}

/** Pedido estruturado de uma célula para outra (F9.2). */
export interface CellRequestArgs {
  /** Tipo da célula solicitada. */
  cellType: CellType;
  /** Tarefa/pedido em linguagem natural ou payload estruturado. */
  request: unknown;
  /** Contexto de execução DA CÉLULA SOLICITANTE. */
  context: CellExecutionContext;
  /** Id da célula solicitante. */
  parentCellId: CellId;
}

/**
 * Supervisor cognitivo: permite uma célula solicitar outra célula (F9.2).
 * Implementação real: executa a célula alvo com enforcement de profundidade,
 * orçamento de chamadas, detecção de ciclo e timeout.
 */
export interface CellSupervisor {
  /**
   * Solicita execução de outra célula e retorna o resultado dela.
   * Pode lançar CellDelegationError com reason estruturado quando
   * depth/ciclo/budget/timeout são violados.
   */
  requestCell(args: CellRequestArgs): Promise<CellOutput>;

  /** Registra uma mensagem de uma célula para outra. */
  emit(cellType: CellType, fromCellId: CellId, message: string, payload?: unknown): Promise<void>;
}

/** Motivos de bloqueio de delegação (F9.2). */
export type CellDelegationReason =
  | "CYCLE_DETECTED"
  | "DEPTH_EXCEEDED"
  | "BUDGET_EXCEEDED"
  | "TIMEOUT"
  | "CELL_NOT_FOUND";

/** Erro estruturado de delegação entre células (F9.2). */
export class CellDelegationError extends Error {
  public readonly reason: CellDelegationReason;
  public readonly detail?: Record<string, unknown>;

  constructor(reason: CellDelegationReason, message: string, detail?: Record<string, unknown>) {
    super(message);
    this.name = "CellDelegationError";
    this.reason = reason;
    this.detail = detail;
  }
}

/**
 * Orçamentos específicos por célula.
 */
export interface CellBudgets {
  maxTokens: number;
  maxDurationMs: number;
  maxToolCalls: number;
  maxCostUsd: number;
}

/**
 * Configuração de sandbox para execução segura.
 */
export interface SandboxConfig {
  /** Diretório raiz para operações de filesystem. */
  fsRoot: string;
  /** Permissões de tools permitidas. */
  allowedTools: string[];
  /** Se pode executar comandos shell. */
  allowShell: boolean;
  /** Se pode fazer requisições HTTP. */
  allowHttp: boolean;
  /** Variáveis de ambiente permitidas para leitura. */
  allowedEnvVars: string[];
}

/**
 * Input genérico para execução de uma célula.
 */
export interface CellInput {
  /** Tipo de input específico da célula. */
  type: string;
  /** Payload do input. */
  payload: unknown;
  /** Metadados opcionais. */
  metadata?: Record<string, unknown>;
}

/**
 * Output genérico de execução de uma célula.
 */
export interface CellOutput<T = unknown> {
  /** Se a execução foi bem-sucedida. */
  success: boolean;
  /** Resultado tipado da célula. */
  data?: T;
  /** Erro se falhou. */
  error?: CellError;
  /** Métricas de execução. */
  metrics: CellMetrics;
  /** Rastreabilidade: qual célula produziu este output. */
  provenance: CellProvenance;
}

/**
 * Métricas de execução de uma célula.
 */
export interface CellMetrics {
  tokensUsed: number;
  durationMs: number;
  toolCalls: number;
  costUsd: number;
}

/**
 * Erro estruturado de célula.
 */
export interface CellError {
  code: string;
  message: string;
  details?: unknown;
  recoverable: boolean;
}

/**
 * Proveniência de um resultado de célula.
 */
export interface CellProvenance {
  cellId: CellId;
  cellType: CellType;
  timestamp: number;
  sessionId: string;
  taskId: string;
  inputHash: string;
  /** Fase 9.2 — célula que solicitou esta execução (quando via supervisor). */
  parentCellId?: CellId;
  parentCellType?: CellType;
  /** Profundidade na cadeia de delegação (0 = despachada pelo router). */
  depth?: number;
}

/**
 * Health check de uma célula.
 */
export interface CellHealth {
  healthy: boolean;
  checks: CellHealthCheck[];
  lastCheck: number;
}

export interface CellHealthCheck {
  name: string;
  status: "pass" | "warn" | "fail";
  message: string;
}

/**
 * Interface principal que toda célula cognitiva deve implementar.
 */
export interface CognitiveCell<TInput extends CellInput = CellInput, TOutput = unknown> {
  /** Identificador único da célula. */
  readonly id: CellId;
  /** Tipo da célula (para roteamento). */
  readonly type: CellType;
  /** Nome legível para logs. */
  readonly name: string;
  /** Capacidades que esta célula suporta. */
  readonly capabilities: CellCapability[];
  /** Descrição do que a célula faz. */
  readonly description: string;

  /**
   * Verifica se esta célula pode lidar com a tarefa/contexto dado.
   * Usado pelo CognitiveRouter para seleção.
   */
  canHandle(input: TInput, context: CellExecutionContext): Promise<CanHandleResult>;

  /**
   * Executa a célula com o input e contexto fornecidos.
   */
  execute(input: TInput, context: CellExecutionContext): Promise<CellOutput<TOutput>>;

  /**
   * Verifica a saúde da célula.
   */
  health(): Promise<CellHealth>;

  /**
   * Limpa recursos se necessário.
   */
  dispose?(): Promise<void>;
}

/**
 * Resultado da verificação canHandle.
 */
export interface CanHandleResult {
  /** Se a célula pode lidar com o input. */
  canHandle: boolean;
  /** Confiança (0-1). */
  confidence: number;
  /** Razão se não puder lidar. */
  reason?: string;
  /** Capacidades necessárias que a célula tem. */
  matchedCapabilities: CellCapability[];
}

/**
 * Memória cognitiva compartilhada entre células.
 */
export interface CognitiveMemory {
  /** Armazena um valor na memória. */
  set(key: string, value: CognitiveMemoryEntry): Promise<void>;
  /** Recupera um valor da memória. */
  get(key: string): Promise<CognitiveMemoryEntry | undefined>;
  /** Remove um valor da memória. */
  delete(key: string): Promise<void>;
  /** Lista chaves com prefixo. */
  list(prefix: string): Promise<string[]>;
  /** Limpa toda a memória da sessão. */
  clear(): Promise<void>;
}

/**
 * Entrada na memória cognitiva.
 */
export interface CognitiveMemoryEntry {
  /** Valor armazenado. */
  value: unknown;
  /** ID da célula que escreveu. */
  cellId: CellId;
  /** Tipo da célula que escreveu. */
  cellType: CellType;
  /** Timestamp da escrita. */
  timestamp: number;
  /** Session ID para isolamento. */
  sessionId: string;
  /** Task ID para rastreabilidade. */
  taskId: string;
  /** Tags para busca/filtro. */
  tags: string[];
  /** Versão para otimistic locking. */
  version: number;
}

/**
 * Mensagem estruturada entre células (F9.4).
 */
export interface CellMessage<T = unknown> {
  /** ID único da mensagem. */
  id: string;
  /** Célula origem. */
  fromCellId: CellId;
  /** Tipo da célula origem. */
  fromCellType: CellType;
  /** Célula destino (null = broadcast). */
  toCellId: CellId | null;
  /** Tipo da célula destino (para broadcast por tipo). */
  toCellType: CellType | null;
  /** Tipo de mensagem. */
  messageType: CellMessageType;
  /** Payload da mensagem. */
  payload: T;
  /** Timestamp. */
  timestamp: number;
  /** Correlation ID para rastrear fluxos. */
  correlationId: string;
  /** Se requer resposta. */
  requiresResponse: boolean;
  /** Timeout para resposta em ms. */
  responseTimeoutMs?: number;
}

/**
 * Tipos de mensagens entre células.
 */
export type CellMessageType =
  | "research_findings"      // ResearchCell → DebugCell/PlanningCell
  | "debug_diagnosis"        // DebugCell → PlanningCell
  | "plan_request"           // PlanningCell → CodeReviewCell
  | "review_request"         // Qualquer → CodeReviewCell
  | "config_change"          // ConfigCell → outras
  | "context_share"          // Compartilhamento genérico de contexto
  | "handoff"                // Passagem de responsabilidade
  | "acknowledgment";        // Confirmação de recebimento

/**
 * Resultado de dispatch do router para múltiplas células.
 */
export interface MultiCellDispatchResult {
  /** Resultados de cada célula executada. */
  results: Map<CellId, CellOutput>;
  /** Mensagens trocadas entre células durante execução. */
  messages: CellMessage[];
  /** Se todas as células completaram com sucesso. */
  allSuccessful: boolean;
  /** Erros agregados. */
  errors: CellError[];
}

/**
 * Configuração do Cognitive Router.
 */
export interface CognitiveRouterConfig {
  /** Células registradas. */
  cells: CognitiveCell[];
  /** Memória cognitiva compartilhada. */
  cognitiveMemory: CognitiveMemory;
  /** Configuração padrão de budgets. */
  defaultBudgets: CellBudgets;
  /** Configuração padrão de sandbox. */
  defaultSandbox: SandboxConfig;
  /** Habilita dispatch paralelo para tarefas compostas. */
  enableParallelDispatch: boolean;
  /** Timeout para comunicação entre células. */
  interCellTimeoutMs: number;
  /** Máximo de células em dispatch paralelo. */
  maxParallelCells: number;
}