/**
 * ProjectTool — cria (scaffold) um projeto de vários arquivos de uma vez a
 * partir de uma lista estruturada {path, content}, e opcionalmente entrega
 * o resultado compactado em .zip.
 *
 * Por que esta tool existe separada de FilesystemTool/CompressionTool:
 * o loop autônomo padrão (ver executor.ts) deriva os parâmetros de cada
 * chamada de ferramenta usando regex sobre a descrição em texto de UMA
 * etapa do plano — isso funciona bem para uma ação simples ("leia o
 * arquivo X"), mas é estruturalmente inadequado para "monte um projeto"
 * (múltiplos arquivos, cada um com conteúdo de código de verdade — não dá
 * pra extrair isso de uma frase curta com regex). Por isso esta tool tem
 * uma única ação que recebe TODOS os arquivos de uma vez, em JSON
 * estruturado — pensada para ser preenchida por uma chamada dedicada ao
 * LLM (ver runProjectScaffold em runtime.ts), não pelo derivador genérico
 * de passos do loop autônomo.
 */

import { existsSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { dirname, join, normalize, sep } from "node:path";
import { z } from "zod";

import type { Tool, ToolResult } from "../types.js";
import type { SecurityPolicy } from "./security.js";
import { resolveSafePath } from "./security.js";
import { createProjectZip } from "../../lib/compression.js";

export const ProjectFileInput = z.object({
  /** Caminho RELATIVO ao próprio projeto (ex.: "src/index.js", "package.json"). */
  path: z.string().min(1),
  content: z.string(),
});

export const ProjectScaffoldInput = z.object({
  action: z.literal("scaffold"),
  /** Nome do projeto — vira o nome da pasta (e do .zip, se `zip` !== false). */
  projectName: z.string().min(1),
  files: z.array(ProjectFileInput).min(1).max(300),
  /** Compacta o projeto em .zip ao final. Default: true. */
  zip: z.boolean().optional(),
});

export const ProjectToolInput = ProjectScaffoldInput;

export type ProjectFileInput = z.infer<typeof ProjectFileInput>;
export type ProjectScaffoldInput = z.infer<typeof ProjectScaffoldInput>;
export type ProjectToolInput = z.infer<typeof ProjectToolInput>;

/** Normaliza um nome de projeto para algo seguro como nome de pasta/arquivo. */
export function sanitizeProjectName(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[\\/]+/g, "-")
    .replace(/[^\w.-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return cleaned.length > 0 ? cleaned.slice(0, 80) : "projeto";
}

/**
 * Normaliza o caminho relativo de UM arquivo dentro do projeto, recusando
 * qualquer tentativa de escapar da pasta do projeto (".." ou caminho
 * absoluto) — a validação final e definitiva ainda é `resolveSafePath`
 * (contra o workspace inteiro), isto é só a primeira camada específica do
 * "dentro do próprio projeto".
 */
function sanitizeRelativeFilePath(rawPath: string): string | null {
  const cleaned = rawPath.trim().replace(/^[/\\]+/, "");
  if (!cleaned) return null;
  const normalized = normalize(cleaned);
  if (normalized.startsWith("..") || normalized.split(sep).includes("..")) {
    return null;
  }
  return normalized;
}

export class ProjectTool implements Tool<ProjectToolInput> {
  readonly name = "project";
  readonly description =
    "Scaffold a small multi-file project on disk from a structured list of {path, content} files in ONE call, " +
    "then optionally package the whole project as a .zip for delivery. Use this instead of many separate " +
    "filesystem writes when the user asks for a project/app/script with more than one file.";

  constructor(private readonly security: SecurityPolicy) {}

  private safePath(path: string): string {
    return resolveSafePath(path, this.security.fsRoot);
  }

  async execute(input: ProjectToolInput): Promise<ToolResult> {
    const start = performance.now();

    try {
      const projectDirName = sanitizeProjectName(input.projectName);
      const projectRoot = this.safePath(projectDirName);

      const written: string[] = [];
      const skipped: string[] = [];

      for (const file of input.files) {
        const relPath = sanitizeRelativeFilePath(file.path);
        if (!relPath) {
          skipped.push(file.path);
          continue;
        }

        const fullPath = this.safePath(join(projectDirName, relPath));
        const dir = dirname(fullPath);
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
        writeFileSync(fullPath, file.content, "utf-8");
        written.push(join(projectDirName, relPath));
      }

      if (written.length === 0) {
        const durationMs = performance.now() - start;
        return {
          success: false,
          output: null,
          error: "Nenhum arquivo válido foi fornecido para o projeto (todos os caminhos foram rejeitados).",
          exitCode: 1,
          durationMs,
          filesChanged: [],
          metadata: { operation: "scaffold", projectName: projectDirName, skipped },
        };
      }

      const skippedNote = skipped.length > 0 ? ` (${skipped.length} caminho(s) inválido(s) ignorado(s))` : "";

      if (input.zip === false) {
        const durationMs = performance.now() - start;
        return {
          success: true,
          output: `Projeto "${projectDirName}" criado com ${written.length} arquivo(s) em ${projectRoot}${skippedNote}.`,
          error: null,
          exitCode: 0,
          durationMs,
          filesChanged: written,
          metadata: { operation: "scaffold", projectName: projectDirName, files: written, projectRoot },
        };
      }

      const zipOutputPath = this.safePath(`${projectDirName}.zip`);
      const zipRes = createProjectZip(projectRoot, zipOutputPath);
      const durationMs = performance.now() - start;

      if (!zipRes.success) {
        // Os arquivos FORAM criados com sucesso — só a compactação falhou.
        // Reporta os dois fatos honestamente em vez de mascarar um com o outro.
        return {
          success: true,
          output:
            `Projeto "${projectDirName}" criado com ${written.length} arquivo(s) em ${projectRoot}${skippedNote}, ` +
            `mas falhou ao compactar: ${zipRes.message}`,
          error: null,
          exitCode: 0,
          durationMs,
          filesChanged: written,
          metadata: { operation: "scaffold", projectName: projectDirName, files: written, projectRoot, zipFailed: true },
        };
      }

      return {
        success: true,
        output:
          `Projeto "${projectDirName}" criado com ${written.length} arquivo(s) e compactado com sucesso em ` +
          `${zipRes.outputPath}${skippedNote}.`,
        error: null,
        exitCode: 0,
        durationMs,
        filesChanged: [...written, zipRes.outputPath ?? zipOutputPath],
        metadata: {
          operation: "scaffold",
          projectName: projectDirName,
          files: written,
          projectRoot,
          zipPath: zipRes.outputPath ?? zipOutputPath,
        },
      };
    } catch (err) {
      const durationMs = performance.now() - start;
      return {
        success: false,
        output: null,
        error: err instanceof Error ? err.message : String(err),
        exitCode: 1,
        durationMs,
        filesChanged: [],
        metadata: { operation: "scaffold" },
      };
    }
  }
}
