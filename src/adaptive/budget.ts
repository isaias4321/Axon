/**
 * Fase 6 — Budget Manager.
 *
 * Enforca limites de orçamento e segurança de forma centralizada.
 * Verifica antes de cada ação e atualiza depois.
 */

import type { AutonomousBudgets, TerminationReason } from "./types.js";

export type { AutonomousBudgets };

export interface BudgetCheckResult {
  exceeded: boolean;
  reason: TerminationReason | null;
  message: string;
  remaining: BudgetRemaining;
}

export interface BudgetRemaining {
  iterations: number;
  costUsd: number;
  durationMs: number;
  toolCalls: number | null;
  tokens: number | null;
}

export interface BudgetUsage {
  iterations: number;
  costUsd: number;
  durationMs: number;
  toolCalls: number;
  tokens: number;
}

/**
 * BudgetManager — verifica e atualiza budgets de forma centralizada.
 *
 * ANTES de cada ação: check().
 * DEPOIS de cada ação: consume().
 */
export class BudgetManager {
  private budgets: AutonomousBudgets;
  private usage: BudgetUsage;
  private startedAt: number;

  constructor(budgets: AutonomousBudgets, startedAt?: number) {
    this.budgets = budgets;
    this.usage = {
      iterations: 0,
      costUsd: 0,
      durationMs: 0,
      toolCalls: 0,
      tokens: 0,
    };
    this.startedAt = startedAt ?? Date.now();
  }

  /** Verifica todos os budgets antes de executar uma nova ação. */
  check(): BudgetCheckResult {
    const elapsedMs = Date.now() - this.startedAt;

    // 1. Iterations
    if (this.usage.iterations >= this.budgets.maxIterations) {
      return {
        exceeded: true,
        reason: "max_iterations",
        message: `Limite de iterações atingido: ${this.budgets.maxIterations}`,
        remaining: this.calculateRemaining(elapsedMs),
      };
    }

    // 2. Duration
    if (elapsedMs >= this.budgets.maxDurationMs) {
      return {
        exceeded: true,
        reason: "timeout",
        message: `Limite de duração atingido: ${this.budgets.maxDurationMs}ms`,
        remaining: this.calculateRemaining(elapsedMs),
      };
    }

    // 3. Cost
    if (this.usage.costUsd >= this.budgets.maxCostUsd) {
      return {
        exceeded: true,
        reason: "max_cost",
        message: `Limite de custo atingido: $${this.budgets.maxCostUsd}`,
        remaining: this.calculateRemaining(elapsedMs),
      };
    }

    // 4. Tool Calls
    if (this.budgets.maxToolCalls && this.usage.toolCalls >= this.budgets.maxToolCalls) {
      return {
        exceeded: true,
        reason: "max_tool_calls",
        message: `Limite de tool calls atingido: ${this.budgets.maxToolCalls}`,
        remaining: this.calculateRemaining(elapsedMs),
      };
    }

    // 5. Tokens
    if (this.budgets.maxTokens && this.usage.tokens >= this.budgets.maxTokens) {
      return {
        exceeded: true,
        reason: "max_tokens",
        message: `Limite de tokens atingido: ${this.budgets.maxTokens}`,
        remaining: this.calculateRemaining(elapsedMs),
      };
    }

    return {
      exceeded: false,
      reason: null,
      message: "Dentro dos limites",
      remaining: this.calculateRemaining(elapsedMs),
    };
  }

  /** Atualiza o uso após uma ação. */
  consume(costUsd?: number, tokens?: number, isIteration = false, isToolCall = false): void {
    if (isIteration) {
      this.usage.iterations += 1;
    }
    if (isToolCall) {
      this.usage.toolCalls += 1;
    }
    if (costUsd) {
      this.usage.costUsd += costUsd;
    }
    if (tokens) {
      this.usage.tokens += tokens;
    }
    this.usage.durationMs = Date.now() - this.startedAt;
  }

  /** Marca uma iteração (chamado antes de cada ciclo do loop). */
  startIteration(): void {
    this.usage.iterations += 1;
  }

  /** Marca uma tool call. */
  recordToolCall(costUsd?: number, tokens?: number): void {
    this.usage.toolCalls += 1;
    if (costUsd) {
      this.usage.costUsd += costUsd;
    }
    if (tokens) {
      this.usage.tokens += tokens;
    }
    this.usage.durationMs = Date.now() - this.startedAt;
  }

  getUsage(): BudgetUsage {
    return { ...this.usage, durationMs: Date.now() - this.startedAt };
  }

  private calculateRemaining(elapsedMs: number): BudgetRemaining {
    return {
      iterations: Math.max(0, this.budgets.maxIterations - this.usage.iterations),
      costUsd: Math.max(0, this.budgets.maxCostUsd - this.usage.costUsd),
      durationMs: Math.max(0, this.budgets.maxDurationMs - elapsedMs),
      toolCalls: this.budgets.maxToolCalls ? Math.max(0, this.budgets.maxToolCalls - this.usage.toolCalls) : null,
      tokens: this.budgets.maxTokens ? Math.max(0, this.budgets.maxTokens - this.usage.tokens) : null,
    };
  }
}
