/**
 * DocumentTool — cria arquivos ZIP, PDF e gráficos SVG (barra/pizza/
 * fluxograma) dentro do workspace.
 *
 * Mesma política de segurança do FilesystemTool: toda saída é restrita ao
 * `fsRoot` (via `resolveSafePath`, compartilhado com `registry.ts`) — não
 * existe caminho novo de escrita fora do workspace só porque a ferramenta é
 * diferente.
 */

import { mkdirSync, writeFileSync, statSync, existsSync, createWriteStream } from "node:fs";
import { join, basename } from "node:path";
import AdmZip from "adm-zip";
import PDFDocument from "pdfkit";
import { z } from "zod";

import type { Tool, ToolResult } from "../types.js";
import type { SecurityPolicy } from "./registry.js";
import { resolveSafePath } from "./registry.js";
import { renderChartSvg, type ChartType, type ChartDataPoint } from "./charts.js";

// ─── Schemas de entrada ─────────────────────────────────────────────────

export const ZipCreateInput = z.object({
  action: z.literal("zip"),
  outputPath: z.string().min(1),
  /** Caminhos de arquivos JÁ EXISTENTES no workspace a compactar. */
  sourcePaths: z.array(z.string().min(1)).min(1).max(50),
});

export const PdfCreateInput = z.object({
  action: z.literal("pdf"),
  outputPath: z.string().min(1),
  title: z.string().optional(),
  content: z.string().min(1),
});

export const ChartCreateInput = z.object({
  action: z.literal("chart"),
  outputPath: z.string().min(1),
  chartType: z.enum(["bar", "pie", "flowchart"]),
  title: z.string().optional(),
  data: z
    .array(z.object({ label: z.string().min(1), value: z.number().optional() }))
    .min(1)
    .max(20),
});

export const DocumentInput = z.discriminatedUnion("action", [ZipCreateInput, PdfCreateInput, ChartCreateInput]);
export type ZipCreateInput = z.infer<typeof ZipCreateInput>;
export type PdfCreateInput = z.infer<typeof PdfCreateInput>;
export type ChartCreateInput = z.infer<typeof ChartCreateInput>;
export type DocumentInput = z.infer<typeof DocumentInput>;

/** Tamanho máximo por arquivo-fonte ao montar um ZIP (proteção contra zip bombs invertidas / uso indevido de memória). */
const MAX_SOURCE_FILE_BYTES = 25 * 1024 * 1024; // 25MB

export class DocumentTool implements Tool<DocumentInput> {
  readonly name = "document";
  readonly description = "Create ZIP archives, PDF documents, and simple SVG charts (bar/pie/flowchart).";

  constructor(private readonly security: SecurityPolicy) {}

  private safePath(path: string): string {
    return resolveSafePath(path, this.security.fsRoot);
  }

  async execute(input: DocumentInput): Promise<ToolResult> {
    const start = performance.now();
    try {
      switch (input.action) {
        case "zip":
          return this.handleZip(input, start);
        case "pdf":
          return await this.handlePdf(input, start);
        case "chart":
          return this.handleChart(input, start);
      }
    } catch (error) {
      return {
        success: false,
        output: null,
        error: error instanceof Error ? error.message : String(error),
        exitCode: 1,
        durationMs: performance.now() - start,
        filesChanged: [],
        metadata: { operation: input.action },
      };
    }
  }

  private handleZip(input: ZipCreateInput, start: number): ToolResult {
    const outPath = this.safePath(input.outputPath);
    const dir = join(outPath, "..");
    mkdirSync(dir, { recursive: true });

    const zip = new AdmZip();
    const included: string[] = [];
    const missing: string[] = [];

    for (const rawPath of input.sourcePaths) {
      const srcPath = this.safePath(rawPath);
      if (!existsSync(srcPath)) {
        missing.push(rawPath);
        continue;
      }
      const stats = statSync(srcPath);
      if (!stats.isFile()) {
        missing.push(rawPath);
        continue;
      }
      if (stats.size > MAX_SOURCE_FILE_BYTES) {
        return {
          success: false,
          output: null,
          error: `Arquivo '${rawPath}' (${stats.size} bytes) excede o limite de ${MAX_SOURCE_FILE_BYTES} bytes por arquivo-fonte.`,
          exitCode: 1,
          durationMs: performance.now() - start,
          filesChanged: [],
          metadata: { operation: "zip", path: outPath },
        };
      }
      zip.addLocalFile(srcPath, "", basename(srcPath));
      included.push(rawPath);
    }

    if (included.length === 0) {
      return {
        success: false,
        output: null,
        error: `Nenhum dos arquivos-fonte foi encontrado: ${missing.join(", ")}`,
        exitCode: 1,
        durationMs: performance.now() - start,
        filesChanged: [],
        metadata: { operation: "zip", path: outPath, missing },
      };
    }

    zip.writeZip(outPath);
    const stats = statSync(outPath);

    const missingNote = missing.length > 0 ? ` (não encontrados, ignorados: ${missing.join(", ")})` : "";
    return {
      success: true,
      output: `Created ZIP with ${included.length} file(s) at ${outPath} (${stats.size} bytes)${missingNote}`,
      error: null,
      exitCode: 0,
      durationMs: performance.now() - start,
      filesChanged: [outPath],
      metadata: { operation: "zip", path: outPath, entries: included, missing, bytes: stats.size },
    };
  }

  private async handlePdf(input: PdfCreateInput, start: number): Promise<ToolResult> {
    const outPath = this.safePath(input.outputPath);
    const dir = join(outPath, "..");
    mkdirSync(dir, { recursive: true });

    await writePdfDocument(outPath, input.title, input.content);
    const stats = statSync(outPath);

    return {
      success: true,
      output: `Created PDF at ${outPath} (${stats.size} bytes)`,
      error: null,
      exitCode: 0,
      durationMs: performance.now() - start,
      filesChanged: [outPath],
      metadata: { operation: "pdf", path: outPath, bytes: stats.size },
    };
  }

  private handleChart(input: ChartCreateInput, start: number): ToolResult {
    const outPath = this.safePath(input.outputPath);
    const dir = join(outPath, "..");
    mkdirSync(dir, { recursive: true });

    const svg = renderChartSvg(input.chartType, input.data, input.title);
    writeFileSync(outPath, svg, "utf-8");
    const stats = statSync(outPath);

    return {
      success: true,
      output: `Created ${input.chartType} chart (SVG) at ${outPath} (${stats.size} bytes)`,
      error: null,
      exitCode: 0,
      durationMs: performance.now() - start,
      filesChanged: [outPath],
      metadata: { operation: "chart", path: outPath, chartType: input.chartType, bytes: stats.size },
    };
  }
}

/** Gera um PDF real via pdfkit, aguardando o stream terminar de gravar em disco. */
function writePdfDocument(outPath: string, title: string | undefined, content: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const stream = createWriteStream(outPath);
    doc.pipe(stream);

    if (title) {
      doc.fontSize(20).text(title, { align: "left" });
      doc.moveDown();
    }
    doc.fontSize(12).text(content, { align: "left" });
    doc.end();

    stream.on("finish", () => resolvePromise());
    stream.on("error", (err) => reject(err));
  });
}

// Re-exportado por conveniência (usado por buildToolInput/testes sem precisar
// importar de `charts.ts` diretamente).
export type { ChartType, ChartDataPoint };
