/**
 * Fase 9 — Base Cognitive Cell Implementation.
 *
 * Classe base abstrata que implementa funcionalidade comum para todas as células.
 */

import type {
  CognitiveCell,
  CellInput,
  CellOutput,
  CellExecutionContext,
  CellMetrics,
  CellError,
  CellProvenance,
  CellHealth,
  CellHealthCheck,
  CanHandleResult,
  CellCapability,
  CellId,
  CellType,
} from "./types.js";

/**
 * Classe base abstrata para células cognitivas.
 * Fornece implementação padrão para funcionalidades comuns.
 */
export abstract class BaseCognitiveCell<
  TInput extends CellInput = CellInput,
  TOutput = unknown
> implements CognitiveCell<TInput, TOutput> {
  public abstract readonly id: CellId;
  public abstract readonly type: CellType;
  public abstract readonly name: string;
  public abstract readonly capabilities: CellCapability[];
  public abstract readonly description: string;

  protected startTime: number = 0;
  protected toolCallCount: number = 0;
  protected tokenCount: number = 0;
  protected costAccumulator: number = 0;

  /**
   * Verifica se a célula pode lidar com o input.
   * Implementação padrão baseada em capabilities declaradas.
   */
  async canHandle(input: TInput, _context: CellExecutionContext): Promise<CanHandleResult> {
    // Por padrão, verifica se o tipo de input corresponde às capabilities
    const matchedCapabilities = this.capabilities.filter(cap =>
      this.inputMatchesCapability(input, cap)
    );

    return {
      canHandle: matchedCapabilities.length > 0,
      confidence: matchedCapabilities.length > 0 ? 0.8 : 0.1,
      reason: matchedCapabilities.length === 0
        ? `Input type '${input.type}' não corresponde a nenhuma capability declarada: ${this.capabilities.join(", ")}`
        : undefined,
      matchedCapabilities,
    };
  }

  /**
   * Executa a célula com tracking de métricas.
   */
  async execute(input: TInput, context: CellExecutionContext): Promise<CellOutput<TOutput>> {
    this.startExecution();

    try {
      const result = await this.executeImpl(input, context);
      return this.successResult(result, context);
    } catch (error) {
      return this.errorResult(error, context);
    } finally {
      this.endExecution();
    }
  }

  /**
   * Implementação específica da execução - deve ser sobrescrita pelas subclasses.
   */
  protected abstract executeImpl(input: TInput, context: CellExecutionContext): Promise<TOutput>;

  /**
   * Health check da célula.
   */
  async health(): Promise<CellHealth> {
    const checks: CellHealthCheck[] = [
      {
        name: "base_initialization",
        status: "pass",
        message: "Célula base inicializada corretamente",
      },
      {
        name: "capabilities_declared",
        status: this.capabilities.length > 0 ? "pass" : "warn",
        message: this.capabilities.length > 0
          ? `${this.capabilities.length} capabilities declaradas`
          : "Nenhuma capability declarada",
      },
    ];

    // Subclasses podem adicionar checks específicos
    const specificChecks = await this.specificHealthChecks();
    checks.push(...specificChecks);

    const healthy = checks.every(c => c.status !== "fail");

    return {
      healthy,
      checks,
      lastCheck: Date.now(),
    };
  }

  /**
   * Health checks específicos da implementação.
   */
  protected async specificHealthChecks(): Promise<CellHealthCheck[]> {
    return [];
  }

  /**
   * Limpa recursos.
   */
  async dispose(): Promise<void> {
    // Override se necessário
  }

  // Métodos protegidos para tracking de métricas

  protected startExecution(): void {
    this.startTime = Date.now();
    this.toolCallCount = 0;
    this.tokenCount = 0;
    this.costAccumulator = 0;
  }

  protected endExecution(): void {
    // Finalização se necessária
  }

  protected recordToolCall(): void {
    this.toolCallCount++;
  }

  protected recordTokens(tokens: number): void {
    this.tokenCount += tokens;
  }

  protected recordCost(cost: number): void {
    this.costAccumulator += cost;
  }

  protected buildMetrics(): CellMetrics {
    return {
      tokensUsed: this.tokenCount,
      durationMs: Date.now() - this.startTime,
      toolCalls: this.toolCallCount,
      costUsd: this.costAccumulator,
    };
  }

  protected buildProvenance(context: CellExecutionContext): CellProvenance {
    // Hash simples do input para rastreabilidade
    const inputHash = this.hashInput(context);

    return {
      cellId: this.id,
      cellType: this.type,
      timestamp: Date.now(),
      sessionId: context.sessionId ?? "unknown",
      taskId: context.taskId ?? "unknown",
      inputHash,
      // Fase 9.2 — linhagem de delegação (quando executada via supervisor)
      ...(context.parentCell
        ? {
            parentCellId: context.parentCell.id,
            parentCellType: context.parentCell.type,
            depth: context.parentCell.depth,
          }
        : {}),
    };
  }

  protected successResult(data: TOutput, context: CellExecutionContext): CellOutput<TOutput> {
    return {
      success: true,
      data,
      metrics: this.buildMetrics(),
      provenance: this.buildProvenance(context),
    };
  }

  protected errorResult(error: unknown, context: CellExecutionContext): CellOutput<TOutput> {
    const cellError: CellError = error instanceof Error
      ? {
          code: "EXECUTION_ERROR",
          message: error.message,
          details: error.stack,
          recoverable: this.isRecoverable(error),
        }
      : {
          code: "UNKNOWN_ERROR",
          message: String(error),
          recoverable: false,
        };

    return {
      success: false,
      error: cellError,
      metrics: this.buildMetrics(),
      provenance: this.buildProvenance(context),
    };
  }

  protected isRecoverable(error: unknown): boolean {
    // Por padrão, erros de validação/timeout são recuperáveis
    if (error instanceof Error) {
      const recoverablePatterns = [
        "timeout",
        "validation",
        "rate limit",
        "temporary",
        "unavailable",
      ];
      return recoverablePatterns.some(p => error.message.toLowerCase().includes(p));
    }
    return false;
  }

  /**
   * Verifica se o input corresponde a uma capability.
   * Override nas subclasses para lógica específica.
   */
  protected inputMatchesCapability(input: CellInput, capability: CellCapability): boolean {
    // Mapeamento básico type -> capability
    const typeCapabilityMap: Record<string, CellCapability[]> = {
      "research": ["code_search", "web_search"],
      "research_query": ["code_search", "web_search"],
      "debug": ["error_analysis", "log_analysis", "root_cause_analysis"],
      "debug_error": ["error_analysis", "log_analysis", "root_cause_analysis"],
      "planning": ["plan_generation", "replanning"],
      "plan_request": ["plan_generation", "replanning"],
      "code_review": ["code_review_correctness", "code_review_security", "code_review_performance", "code_review_simplification"],
      "config": ["config_view", "config_update", "config_validate", "config_diff", "config_reset"],
      "config_action": ["config_view", "config_update", "config_validate", "config_diff", "config_reset"],
      "validation": ["validation"],
      "recovery": ["recovery"],
    };

    const caps = typeCapabilityMap[input.type] || [];
    return caps.includes(capability);
  }

  /**
   * Hash simples para proveniência.
   */
  protected hashInput(context: CellExecutionContext): string {
    const str = `${context.sessionId}-${context.taskId}-${Date.now()}`;
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(36);
  }
}