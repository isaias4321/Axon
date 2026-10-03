/**
 * Fase 9.1 — Cognitive Tools.
 *
 * Constrói um ToolRegistry para as células cognitivas, reutilizando o
 * DefaultToolRegistry da Fase 8 (filesystem/shell/http com security policy)
 * e adicionando a tool `grep` (busca regex no fsRoot).
 */

import {
  createDefaultToolRegistry,
  type ToolRegistry,
  type ToolRegistryOptions,
} from "../../adaptive/tools/registry.js";
import { GrepTool } from "./grep.js";
import type { CellToolRegistry } from "../types.js";

export { GrepTool } from "./grep.js";
export { GrepInput } from "./grep.js";
export type { GrepMatch } from "./grep.js";

/**
 * Cria o ToolRegistry padrão para células: filesystem + shell + http (F8)
 * + grep (F9.1), todos com a mesma security policy.
 */
export function createCognitiveToolRegistry(
  options?: ToolRegistryOptions & { fsRoot?: string }
): ToolRegistry {
  const security = {
    ...(options?.security ?? {}),
    // Se fsRoot foi passado explicitamente, usa-o; senão mantém o default F8
    fsRoot: options?.fsRoot ?? options?.security?.fsRoot ?? undefined,
  };

  const registry = createDefaultToolRegistry({
    security,
    enableHistory: options?.enableHistory,
    maxHistorySize: options?.maxHistorySize,
  });

  // Registra a tool grep com o mesmo fsRoot da security policy
  const fsRoot = security.fsRoot ?? null;
  registry.register(new GrepTool(fsRoot));

  return registry;
}

/**
 * Adapta um ToolRegistry F8 para o contrato mínimo usado pelas células.
 */
export function toCellToolRegistry(registry: ToolRegistry): CellToolRegistry {
  return {
    execute: async (name, input) => {
      const result = await registry.execute(name, input as never);
      return {
        success: result.success,
        output: result.output,
        error: result.error,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        filesChanged: result.filesChanged,
        metadata: result.metadata,
      };
    },
    list: () => registry.list(),
    getHistory: () => registry.getHistory(),
  };
}

export type { ToolRegistry, ToolRegistryOptions };
