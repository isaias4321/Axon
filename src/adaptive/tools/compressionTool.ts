/**
 * CompressionTool — ferramenta para manipulação e criação de arquivos compactados (.zip / .rar).
 */

import { z } from "zod";
import type { Tool, ToolResult } from "../types.js";
import type { SecurityPolicy } from "./security.js";
import { resolveSafePath } from "./security.js";
import {
  createZipArchive,
  createRarArchive,
  extractZipArchive,
  extractRarArchive,
  listZipEntries,
  listRarEntries,
  detectArchiveFormat,
} from "../../lib/compression.js";

export const CompressionZipInput = z.object({
  action: z.literal("zip"),
  outputPath: z.string().min(1),
  sourcePaths: z.array(z.string().min(1)).min(1),
  comment: z.string().optional(),
});

export const CompressionRarInput = z.object({
  action: z.literal("rar"),
  outputPath: z.string().min(1),
  sourcePaths: z.array(z.string().min(1)).min(1),
});

export const CompressionExtractInput = z.object({
  action: z.literal("extract"),
  inputPath: z.string().min(1),
  targetDir: z.string().min(1),
});

export const CompressionListInput = z.object({
  action: z.literal("list"),
  inputPath: z.string().min(1),
});

export const CompressionToolInput = z.discriminatedUnion("action", [
  CompressionZipInput,
  CompressionRarInput,
  CompressionExtractInput,
  CompressionListInput,
]);

export type CompressionZipInput = z.infer<typeof CompressionZipInput>;
export type CompressionRarInput = z.infer<typeof CompressionRarInput>;
export type CompressionExtractInput = z.infer<typeof CompressionExtractInput>;
export type CompressionListInput = z.infer<typeof CompressionListInput>;
export type CompressionToolInput = z.infer<typeof CompressionToolInput>;

export class CompressionTool implements Tool<CompressionToolInput> {
  readonly name = "compression";
  readonly description = "Compress and decompress files (.zip, .rar) within the workspace.";

  constructor(private readonly security: SecurityPolicy) {}

  private safePath(path: string): string {
    return resolveSafePath(path, this.security.fsRoot);
  }

  async execute(input: CompressionToolInput): Promise<ToolResult> {
    const start = performance.now();

    try {
      switch (input.action) {
        case "zip": {
          const outPath = this.safePath(input.outputPath);
          const sources = input.sourcePaths.map((p) => this.safePath(p));
          const res = createZipArchive({ outputPath: outPath, sourcePaths: sources, comment: input.comment });
          const durationMs = performance.now() - start;

          return {
            success: res.success,
            output: res.message,
            error: res.success ? null : (res.error ?? res.message),
            exitCode: res.success ? 0 : 1,
            durationMs,
            filesChanged: res.success && res.outputPath ? [res.outputPath] : [],
            metadata: {
              operation: "zip",
              path: outPath,
              bytes: res.bytes,
              filesProcessed: res.filesProcessed,
              missingFiles: res.missingFiles,
            },
          };
        }
        case "rar": {
          const outPath = this.safePath(input.outputPath);
          const sources = input.sourcePaths.map((p) => this.safePath(p));
          const res = createRarArchive({ outputPath: outPath, sourcePaths: sources });
          const durationMs = performance.now() - start;

          return {
            success: res.success,
            output: res.message,
            error: res.success ? null : (res.error ?? res.message),
            exitCode: res.success ? 0 : 1,
            durationMs,
            filesChanged: res.success && res.outputPath ? [res.outputPath] : [],
            metadata: {
              operation: "rar",
              path: outPath,
              bytes: res.bytes,
              filesProcessed: res.filesProcessed,
              missingFiles: res.missingFiles,
            },
          };
        }
        case "extract": {
          const inPath = this.safePath(input.inputPath);
          const outDir = this.safePath(input.targetDir);
          // Detecta o formato REAL pelos bytes do arquivo, não pela
          // extensão do nome — um .rar de verdade não pode ser extraído
          // pelo caminho de ZIP (adm-zip), e vice-versa.
          const format = detectArchiveFormat(inPath);
          const res =
            format === "rar"
              ? extractRarArchive({ inputPath: inPath, targetDir: outDir })
              : extractZipArchive({ inputPath: inPath, targetDir: outDir });
          const durationMs = performance.now() - start;

          return {
            success: res.success,
            output: res.message,
            error: res.success ? null : (res.error ?? res.message),
            exitCode: res.success ? 0 : 1,
            durationMs,
            filesChanged: res.success ? res.filesProcessed.map((f) => `${outDir}/${f}`) : [],
            metadata: {
              operation: "extract",
              inputPath: inPath,
              targetDir: outDir,
              format,
              entries: res.filesProcessed,
            },
          };
        }
        case "list": {
          const inPath = this.safePath(input.inputPath);
          // Idem: decide entre o parser de ZIP e o leitor de RAR pelos
          // bytes reais do arquivo. Antes disso, QUALQUER .rar de verdade
          // caía sempre no parser de ZIP (adm-zip) e falhava com um erro
          // de "formato inválido", já que RAR e ZIP são formatos binários
          // completamente diferentes.
          const format = detectArchiveFormat(inPath);
          const res = format === "rar" ? listRarEntries(inPath) : listZipEntries(inPath);
          const durationMs = performance.now() - start;

          return {
            success: res.success,
            output: JSON.stringify({ tool: "compression", action: "list", path: inPath, format, entries: res.entries }),
            error: res.success ? null : (res.error ?? res.message),
            exitCode: res.success ? 0 : 1,
            durationMs,
            filesChanged: [],
            metadata: {
              operation: "list",
              path: inPath,
              format,
              count: res.entries.length,
            },
          };
        }
      }
    } catch (err) {
      return {
        success: false,
        output: null,
        error: err instanceof Error ? err.message : String(err),
        exitCode: 1,
        durationMs: performance.now() - start,
        filesChanged: [],
        metadata: { operation: input.action },
      };
    }
  }
}
