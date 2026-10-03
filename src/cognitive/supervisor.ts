/**
 * Fase 9.2 — Default Cell Supervisor.
 *
 * Implementação REAL do CellSupervisor: executa a célula solicitada de fato,
 * com enforcement centralizado de:
 *   - detecção de ciclo (delegationChain);
 *   - profundidade máxima (maxDepth);
 *   - orçamento total de chamadas entre células (maxCellCalls);
 *   - timeout por chamada (timeoutMs).
 *
 * Cada violação gera CellDelegationError com reason estruturado e é
 * registrada em `traces` para auditoria/proveniência.
 */

import type {
  CellExecutionContext,
  CellId,
  CellInput,
  CellOutput,
  CellRequestArgs,
  CellSupervisor,
  CellType,
  CognitiveCell,
} from "./types.js";
import { CellDelegationError } from "./types.js";

export interface SupervisorOptions {
  /** Profundidade máxima da cadeia de delegação (default 3). */
  maxDepth?: number;
  /** Número máximo total de chamadas entre células por despacho (default 8). */
  maxCellCalls?: number;
  /** Timeout por chamada inter-célula em ms (default 15000). */
  timeoutMs?: number;
}

/** Registro auditável de uma tentativa de delegação. */
export interface CellCallTrace {
  fromCellId: CellId;
  toCellType: CellType;
  depth: number;
  outcome: "ok" | "cycle_detected" | "depth_exceeded" | "budget_exceeded" | "timeout" | "error" | "not_found";
  durationMs: number;
  message: string;
}

export class DefaultCellSupervisor implements CellSupervisor {
  private readonly maxDepth: number;
  private readonly maxCellCalls: number;
  private readonly timeoutMs: number;
  private callCount = 0;
  public readonly traces: CellCallTrace[] = [];

  constructor(
    private readonly resolveCell: (cellType: CellType) => CognitiveCell | undefined,
    private readonly normalizeInput: (cellType: CellType, request: unknown) => CellInput,
    options: SupervisorOptions = {},
    private readonly onMessage?: (
      toCellType: CellType,
      fromCellId: CellId,
      message: string,
      payload?: unknown
    ) => void
  ) {
    this.maxDepth = options.maxDepth ?? 3;
    this.maxCellCalls = options.maxCellCalls ?? 8;
    this.timeoutMs = options.timeoutMs ?? 15000;
  }

  async requestCell(args: CellRequestArgs): Promise<CellOutput> {
    const startedAt = Date.now();
    const { cellType, request, context, parentCellId } = args;

    const chain = context.delegationChain ?? [];
    const depth = chain.length + 1;

    // 1. Ciclo: o tipo alvo já está na cadeia ancestral (A→B→A, A→B→C→A…)
    if (chain.includes(cellType)) {
      this.record(parentCellId, cellType, depth, "cycle_detected", startedAt,
        `Cadeia [${chain.join(" -> ")}] ja contem '${cellType}'`);
      throw new CellDelegationError("CYCLE_DETECTED",
        `CYCLE_DETECTED: delegar para '${cellType}' fecharia o ciclo [${[...chain, cellType].join(" -> ")}]`,
        { chain: [...chain] });
    }

    // 2. Profundidade máxima
    if (depth > this.maxDepth) {
      this.record(parentCellId, cellType, depth, "depth_exceeded", startedAt,
        `Profundidade ${depth} excede maxDepth=${this.maxDepth}`);
      throw new CellDelegationError("DEPTH_EXCEEDED",
        `DEPTH_EXCEEDED: profundidade ${depth} > maxDepth(${this.maxDepth})`,
        { depth, maxDepth: this.maxDepth });
    }

    // 3. Orçamento total de chamadas
    if (this.callCount >= this.maxCellCalls) {
      this.record(parentCellId, cellType, depth, "budget_exceeded", startedAt,
        `Orcamento de chamadas esgotado (${this.maxCellCalls})`);
      throw new CellDelegationError("BUDGET_EXCEEDED",
        `BUDGET_EXCEEDED: callCount >= maxCellCalls(${this.maxCellCalls})`,
        { callCount: this.callCount, maxCellCalls: this.maxCellCalls });
    }
    this.callCount += 1;

    // 4. Célula registrada?
    const cell = this.resolveCell(cellType);
    if (!cell) {
      this.record(parentCellId, cellType, depth, "not_found", startedAt,
        `Celula '${cellType}' nao registrada`);
      throw new CellDelegationError("CELL_NOT_FOUND", `Célula '${cellType}' não registrada`);
    }

    // 5. Contexto filho: mesmo session/task/tools/memória + ancestral + supervisor
    const childContext: CellExecutionContext = {
      ...context,
      parentCell: { id: parentCellId, type: context.parentCell?.type ?? cellType, depth },
      delegationChain: [...chain, cellType],
      supervisor: this,
    };

    // 6. Executa com timeout
    const input = this.normalizeInput(cellType, request);
    try {
      const output = await this.withTimeout(cell.execute(input, childContext));
      this.record(cell.id, cellType, depth, output.success ? "ok" : "error", startedAt,
        output.success ? "Executou com sucesso" : output.error?.message ?? "Falha da celula");
      return {
        ...output,
        provenance: {
          ...(output.provenance ?? {
            cellId: cell.id,
            cellType,
            timestamp: Date.now(),
            sessionId: context.sessionId,
            taskId: context.taskId,
            inputHash: "",
          }),
          parentCellId,
          parentCellType: context.parentCell?.type,
          depth,
        },
      };
    } catch (error) {
      if (error instanceof CellDelegationError && error.reason === "TIMEOUT") {
        this.record(cell.id, cellType, depth, "timeout", startedAt,
          `Timeout apos ${this.timeoutMs}ms`);
        throw error;
      }
      this.record(cell.id, cellType, depth, "error", startedAt,
        error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async emit(
    cellType: CellType,
    fromCellId: CellId,
    message: string,
    payload?: unknown
  ): Promise<void> {
    this.onMessage?.(cellType, fromCellId, message, payload);
  }

  getTraces(): readonly CellCallTrace[] {
    return this.traces;
  }

  private record(
    fromCellId: CellId,
    toCellType: CellType,
    depth: number,
    outcome: CellCallTrace["outcome"],
    startedAt: number,
    message: string
  ): void {
    this.traces.push({
      fromCellId,
      toCellType,
      depth,
      outcome,
      durationMs: Date.now() - startedAt,
      message,
    });
  }

  private withTimeout(promise: Promise<CellOutput>): Promise<CellOutput> {
    return new Promise<CellOutput>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new CellDelegationError("TIMEOUT",
          `TIMEOUT: celula nao respondeu em ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      promise.then(
        (value) => { clearTimeout(timer); resolve(value); },
        (error) => {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      );
    });
  }
}
