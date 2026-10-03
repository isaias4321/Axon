/**
 * Fase 9.1 — GrepTool.
 *
 * Tool de busca em código (grep) para o ToolRegistry das células cognitivas.
 * Permite que ResearchCell/DebugCell/CodeReviewCell busquem padrões reais no
 * filesystem respeitando a security policy e o fsRoot da ToolRegistry F8.
 *
 * Registrado como "grep" no DefaultToolRegistry — mesmo contrato das tools
 * filesystem/shell/http já existentes.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { z } from "zod";
import type { Tool, ToolResult } from "../../adaptive/tools/registry.js";

export const GrepInput = z.object({
  /** Padrão regex a buscar. */
  pattern: z.string().min(1),
  /** Diretório raiz da busca (limitado ao fsRoot). */
  path: z.string().min(1).default("."),
  /** Padrões de arquivo (glob simples, suporta *). */
  includePatterns: z.array(z.string()).optional(),
  /** Diretórios/arquivos a excluir (nomes base). */
  excludePatterns: z.array(z.string()).optional(),
  /** Case-sensitive. */
  caseSensitive: z.boolean().optional().default(false),
  /** Máximo de matches retornados. */
  maxResults: z.number().int().positive().max(500).optional().default(100),
  /** Profundidade máxima de recursão. */
  maxDepth: z.number().int().positive().max(10).optional().default(8),
});

export type GrepInput = z.infer<typeof GrepInput>;

export interface GrepMatch {
  file: string;
  line: number;
  content: string;
  excerpt: string;
}

export class GrepTool implements Tool<GrepInput> {
  readonly name = "grep";
  readonly description = "Search for regex patterns in files within the allowed root.";

  constructor(
    private readonly fsRoot: string | null = null,
    private readonly excludeAlways: string[] = ["node_modules", ".git", "dist", "coverage"]
  ) {}

  async execute(input: GrepInput): Promise<ToolResult> {
    const start = performance.now();

    const root = resolve(input.path);
    const safeRoot = this.fsRoot ? resolve(this.fsRoot) : root;

    // Restringir busca ao fsRoot
    if (this.fsRoot) {
      const rel = relative(safeRoot, root);
      if (rel.startsWith("..") || rel.startsWith("/")) {
        return this.fail(
          `Path '${input.path}' escapes allowed root '${this.fsRoot}'`,
          start, input
        );
      }
    }

    const regex = new RegExp(
      input.caseSensitive ? input.pattern : input.pattern,
      input.caseSensitive ? undefined : "i"
    );

    const matches: GrepMatch[] = [];
    let filesScanned = 0;

    const walk = (dir: string, depth: number): void => {
      if (depth > input.maxDepth || matches.length >= input.maxResults) return;

      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (matches.length >= input.maxResults) return;
        if (this.excludeAlways.includes(entry.name)) continue;
        if (input.excludePatterns?.includes(entry.name)) continue;

        const fullPath = join(dir, entry.name);

        if (entry.isDirectory()) {
          walk(fullPath, depth + 1);
          continue;
        }

        // Filtro por includePatterns (glob simples)
        if (input.includePatterns && input.includePatterns.length > 0) {
          const included = input.includePatterns.some(p => {
            const regexp = new RegExp("^" + p.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$");
            return regexp.test(entry.name) || regexp.test(fullPath);
          });
          if (!included) continue;
        }

        // Ignorar arquivos grandes demais (> 4MB)
        try {
          const stats = statSync(fullPath);
          if (stats.size > 4 * 1024 * 1024) continue;
        } catch {
          continue;
        }

        filesScanned++;
        let content: string;
        try {
          content = readFileSync(fullPath, "utf-8");
        } catch {
          continue; // binário ou sem permissão
        }

        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]!;
          if (regex.test(line)) {
            matches.push({
              file: fullPath,
              line: i + 1,
              content: line.trim().slice(0, 300),
              excerpt: lines.slice(Math.max(0, i - 1), Math.min(lines.length, i + 2)).join("\n").slice(0, 600),
            });
            if (matches.length >= input.maxResults) return;
          }
        }
      }
    };

    walk(safeRoot, 0);

    const durationMs = performance.now() - start;
    return {
      success: true,
      output: JSON.stringify(matches.slice(0, input.maxResults)),
      error: null,
      exitCode: 0,
      durationMs,
      filesChanged: [],
      metadata: {
        operation: "grep",
        root: safeRoot,
        matchCount: matches.length,
        filesScanned,
      },
    };
  }

  private fail(message: string, start: number, input: unknown): ToolResult {
    return {
      success: false,
      output: null,
      error: message,
      exitCode: 1,
      durationMs: performance.now() - start,
      filesChanged: [],
      metadata: { operation: "grep", reason: "blocked", input },
    };
  }
}