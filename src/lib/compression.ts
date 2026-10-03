/**
 * Módulo de manipulação e criação de arquivos compactados (.zip / .rar).
 *
 * Suporta a compilação e extração de arquivos .zip via adm-zip
 * e suporte a .rar via wrapper CLI (se instalado no sistema) com fallback estruturado.
 */

import { existsSync, mkdirSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { basename, dirname } from "node:path";
import { execSync, execFileSync } from "node:child_process";
import AdmZip from "adm-zip";
import { z } from "zod";

export const CompressionZipOptions = z.object({
  outputPath: z.string().min(1),
  sourcePaths: z.array(z.string().min(1)).min(1),
  comment: z.string().optional(),
});

export const CompressionRarOptions = z.object({
  outputPath: z.string().min(1),
  sourcePaths: z.array(z.string().min(1)).min(1),
});

export const CompressionExtractOptions = z.object({
  inputPath: z.string().min(1),
  targetDir: z.string().min(1),
});

export type CompressionZipOptions = z.infer<typeof CompressionZipOptions>;
export type CompressionRarOptions = z.infer<typeof CompressionRarOptions>;
export type CompressionExtractOptions = z.infer<typeof CompressionExtractOptions>;

export interface CompressionOperationResult {
  success: boolean;
  outputPath?: string;
  bytes?: number;
  filesProcessed: string[];
  missingFiles?: string[];
  message: string;
  error?: string;
  format: "zip" | "rar";
}

/** Tamanho máximo por arquivo-fonte (25MB). */
const MAX_SOURCE_FILE_BYTES = 25 * 1024 * 1024;

/**
 * Cria um arquivo .zip contendo os arquivos indicados em `sourcePaths`.
 */
export function createZipArchive(options: CompressionZipOptions): CompressionOperationResult {
  const { outputPath, sourcePaths, comment } = options;

  const dir = dirname(outputPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const zip = new AdmZip();
  const included: string[] = [];
  const missing: string[] = [];

  for (const srcPath of sourcePaths) {
    if (!existsSync(srcPath)) {
      missing.push(srcPath);
      continue;
    }

    const stats = statSync(srcPath);
    if (!stats.isFile()) {
      missing.push(srcPath);
      continue;
    }

    if (stats.size > MAX_SOURCE_FILE_BYTES) {
      return {
        success: false,
        filesProcessed: included,
        missingFiles: missing,
        message: `O arquivo '${srcPath}' (${stats.size} bytes) excede o limite permitido por arquivo (${MAX_SOURCE_FILE_BYTES} bytes).`,
        error: `File size limit exceeded: ${srcPath}`,
        format: "zip",
      };
    }

    zip.addLocalFile(srcPath, "", basename(srcPath));
    included.push(srcPath);
  }

  if (included.length === 0) {
    return {
      success: false,
      filesProcessed: [],
      missingFiles: missing,
      message: `Nenhum dos arquivos especificados foi encontrado em disco: ${missing.join(", ")}`,
      error: "No valid source files found",
      format: "zip",
    };
  }

  if (comment) {
    zip.addZipComment(comment);
  }

  zip.writeZip(outputPath);
  const finalStats = statSync(outputPath);

  const missingNote = missing.length > 0 ? ` (Arquivos ausentes ignorados: ${missing.join(", ")})` : "";
  return {
    success: true,
    outputPath,
    bytes: finalStats.size,
    filesProcessed: included,
    missingFiles: missing,
    message: `Arquivo ZIP gerado com sucesso em ${outputPath} contendo ${included.length} arquivo(s) (${finalStats.size} bytes)${missingNote}.`,
    format: "zip",
  };
}

/**
 * Compacta uma ÁRVORE DE DIRETÓRIOS inteira (recursivamente, preservando a
 * estrutura de pastas) em um .zip — usado pelo ProjectTool para entregar um
 * projeto com vários arquivos/subpastas como um único download.
 *
 * Diferente de `createZipArchive` (que só aceita arquivos individuais e os
 * acha TODOS na raiz do zip pelo basename, perdendo qualquer estrutura de
 * pastas — apropriado para "zipe estes 3 arquivos", não para "zipe este
 * projeto"), esta função usa `addLocalFolder` do adm-zip, que percorre o
 * diretório recursivamente e mantém os caminhos relativos intactos.
 */
export function createProjectZip(projectDir: string, outputPath: string): CompressionOperationResult {
  if (!existsSync(projectDir) || !statSync(projectDir).isDirectory()) {
    return {
      success: false,
      filesProcessed: [],
      missingFiles: [projectDir],
      message: `Diretório do projeto não encontrado: ${projectDir}`,
      error: `Directory not found: ${projectDir}`,
      format: "zip",
    };
  }

  try {
    const dir = dirname(outputPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const zip = new AdmZip();
    // Segundo argumento vazio: os arquivos entram no zip com o caminho
    // relativo ao próprio `projectDir` (sem prefixar o nome da pasta),
    // então extrair o zip recria os arquivos do projeto diretamente.
    zip.addLocalFolder(projectDir, "");
    zip.writeZip(outputPath);
    const finalStats = statSync(outputPath);
    const entries = zip.getEntries().map((e) => e.entryName);

    return {
      success: true,
      outputPath,
      bytes: finalStats.size,
      filesProcessed: entries,
      missingFiles: [],
      message: `Projeto compactado com sucesso em ${outputPath} contendo ${entries.length} arquivo(s) (${finalStats.size} bytes).`,
      format: "zip",
    };
  } catch (err) {
    return {
      success: false,
      filesProcessed: [],
      missingFiles: [],
      message: `Falha ao compactar o projeto: ${err instanceof Error ? err.message : String(err)}`,
      error: err instanceof Error ? err.message : String(err),
      format: "zip",
    };
  }
}

/**
 * Tenta criar um arquivo .rar utilizando um executável de CLI instalado no sistema (rar, WinRAR, 7z).
 * Caso não haja binário de CLI disponível no sistema, retorna um resultado estruturado de fallback amigável.
 */
export function createRarArchive(options: CompressionRarOptions): CompressionOperationResult {
  const { outputPath, sourcePaths } = options;

  const dir = dirname(outputPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const included: string[] = [];
  const missing: string[] = [];

  for (const srcPath of sourcePaths) {
    if (!existsSync(srcPath)) {
      missing.push(srcPath);
    } else {
      included.push(srcPath);
    }
  }

  if (included.length === 0) {
    return {
      success: false,
      filesProcessed: [],
      missingFiles: missing,
      message: `Nenhum dos arquivos especificados foi encontrado: ${missing.join(", ")}`,
      error: "No valid source files found",
      format: "rar",
    };
  }

  // Tenta encontrar um utilitário CLI para RAR no sistema
  const rarCli = detectRarCli();

  if (!rarCli) {
    return {
      success: false,
      filesProcessed: [],
      missingFiles: missing,
      message: `A criação de arquivos .rar requer utilitário CLI (rar, WinRAR ou 7-Zip) instalado no ambiente do sistema. Como alternativa, utilize o formato .zip.`,
      error: "RAR CLI binary not available on system",
      format: "rar",
    };
  }

  try {
    const quotedSources = included.map((s) => `"${s}"`).join(" ");
    const cmd = `${rarCli.cmd} ${rarCli.buildArgs(outputPath, quotedSources)}`;
    execSync(cmd, { stdio: "pipe" });

    if (!existsSync(outputPath)) {
      throw new Error("Arquivo .rar não foi gerado pelo comando CLI.");
    }

    const finalStats = statSync(outputPath);
    return {
      success: true,
      outputPath,
      bytes: finalStats.size,
      filesProcessed: included,
      missingFiles: missing,
      message: `Arquivo RAR gerado com sucesso via CLI (${rarCli.name}) em ${outputPath} (${finalStats.size} bytes).`,
      format: "rar",
    };
  } catch (err) {
    return {
      success: false,
      filesProcessed: included,
      missingFiles: missing,
      message: `Falha ao executar o comando de compactação RAR: ${err instanceof Error ? err.message : String(err)}`,
      error: err instanceof Error ? err.message : String(err),
      format: "rar",
    };
  }
}

/** Detecta binários de CLI disponíveis para manipulação de RAR no SO. */
function detectRarCli(): { name: string; cmd: string; buildArgs: (out: string, src: string) => string } | null {
  const commands = [
    { name: "rar", cmd: "rar", buildArgs: (out: string, src: string) => `a -ep "${out}" ${src}` },
    { name: "WinRAR", cmd: "winrar", buildArgs: (out: string, src: string) => `a -ep "${out}" ${src}` },
    { name: "7-Zip", cmd: "7z", buildArgs: (out: string, src: string) => `a -t7z "${out}" ${src}` },
  ];

  for (const item of commands) {
    try {
      execSync(process.platform === "win32" ? `where ${item.cmd}` : `which ${item.cmd}`, { stdio: "ignore" });
      return item;
    } catch {
      // Binário não encontrado no PATH
    }
  }

  return null;
}

/**
 * Extrai arquivos de um pacote .zip para o diretório de destino.
 */
export function extractZipArchive(options: CompressionExtractOptions): CompressionOperationResult {
  const { inputPath, targetDir } = options;

  if (!existsSync(inputPath)) {
    return {
      success: false,
      filesProcessed: [],
      message: `Arquivo de entrada não encontrado: ${inputPath}`,
      error: `File not found: ${inputPath}`,
      format: "zip",
    };
  }

  try {
    const zip = new AdmZip(inputPath);
    zip.extractAllTo(targetDir, true);
    const entries = zip.getEntries().map((e) => e.entryName);

    return {
      success: true,
      outputPath: targetDir,
      filesProcessed: entries,
      message: `Arquivo extraído com sucesso para ${targetDir} (${entries.length} itens).`,
      format: "zip",
    };
  } catch (err) {
    return {
      success: false,
      filesProcessed: [],
      message: `Erro ao extrair pacote ZIP: ${err instanceof Error ? err.message : String(err)}`,
      error: err instanceof Error ? err.message : String(err),
      format: "zip",
    };
  }
}

/**
 * Lista o conteúdo de um arquivo .zip.
 */
export function listZipEntries(inputPath: string): { success: boolean; entries: string[]; message: string; error?: string } {
  if (!existsSync(inputPath)) {
    return {
      success: false,
      entries: [],
      message: `Arquivo não encontrado: ${inputPath}`,
      error: `File not found: ${inputPath}`,
    };
  }

  try {
    const zip = new AdmZip(inputPath);
    const entries = zip.getEntries().map((e) => e.entryName);
    return {
      success: true,
      entries,
      message: `Arquivo contém ${entries.length} entrada(s).`,
    };
  } catch (err) {
    return {
      success: false,
      entries: [],
      message: `Falha ao ler entradas do arquivo: ${err instanceof Error ? err.message : String(err)}`,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Detecta o formato real de um arquivo pelos primeiros bytes (assinatura
 * mágica), em vez de confiar na extensão do nome — um ".rar" pode na
 * verdade ser um .zip renomeado (e vice-versa), e o usuário pode ter
 * enviado um .rar de verdade mesmo que o passo do agente tenha sido escrito
 * como "ler o arquivo x.zip". ZIP começa com "PK"; RAR começa com "Rar!".
 */
export function detectArchiveFormat(inputPath: string): "zip" | "rar" | "unknown" {
  try {
    const fd = openSync(inputPath, "r");
    const buf = Buffer.alloc(8);
    readSync(fd, buf, 0, 8, 0);
    closeSync(fd);
    if (buf[0] === 0x50 && buf[1] === 0x4b) return "zip"; // "PK"
    if (buf.toString("latin1", 0, 4) === "Rar!") return "rar";
    return "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Detecta um utilitário CLI capaz de LER (listar/extrair) arquivos .rar
 * reais no sistema. Diferente de `detectRarCli` (usado só para CRIAR .rar,
 * que exige `rar`/WinRAR proprietários), leitura/extração de RAR é possível
 * com `unrar-free` — uma reimplementação livre que este projeto instala no
 * Dockerfile — além de `unrar` (não-livre) ou `7z`, se presentes no sistema.
 */
function detectRarReaderCli(): { name: string; cmd: string } | null {
  const candidates = ["unrar-free", "unrar", "7z", "7za"];
  for (const cmd of candidates) {
    try {
      execFileSync(process.platform === "win32" ? "where" : "which", [cmd], { stdio: "ignore" });
      return { name: cmd, cmd };
    } catch {
      // Binário não encontrado no PATH — tenta o próximo candidato.
    }
  }
  return null;
}

/**
 * Faz o parse da saída verbosa e peculiar de `unrar-free --list`: não existe
 * modo "bare" (só nomes) nessa reimplementação — cada entrada vem em duas
 * linhas (nome, depois tamanho/data/hora/atributos), cercadas por um
 * cabeçalho e um rodapé delimitados por linhas de "----". Diferente do
 * `unrar` proprietário (que aceita `lb` para uma lista simples de nomes).
 */
export function parseUnrarFreeListing(output: string): string[] {
  const lines = output.split(/\r?\n/);
  const separatorIndexes = lines.reduce<number[]>((acc, line, i) => {
    if (/^-{5,}$/.test(line.trim())) acc.push(i);
    return acc;
  }, []);
  if (separatorIndexes.length < 2) return [];

  const [firstSep, lastSep] = [separatorIndexes[0]!, separatorIndexes[separatorIndexes.length - 1]!];
  const body = lines.slice(firstSep + 1, lastSep);

  const entries: string[] = [];
  for (let i = 0; i < body.length; i += 2) {
    const name = body[i]?.trim();
    if (name) entries.push(name);
  }
  return entries;
}

/**
 * Lista as entradas de um arquivo .rar de verdade via CLI (unrar-free/unrar/
 * 7z). `listZipEntries` (via adm-zip) NÃO consegue ler RAR — é um formato
 * binário completamente diferente do ZIP — então antes desta função,
 * inspecionar um .rar real sempre falhava com um erro de "formato inválido"
 * vindo do parser de ZIP.
 */
export function listRarEntries(inputPath: string): { success: boolean; entries: string[]; message: string; error?: string } {
  if (!existsSync(inputPath)) {
    return {
      success: false,
      entries: [],
      message: `Arquivo não encontrado: ${inputPath}`,
      error: `File not found: ${inputPath}`,
    };
  }

  const reader = detectRarReaderCli();
  if (!reader) {
    return {
      success: false,
      entries: [],
      message:
        "A leitura de arquivos .rar reais requer um utilitário CLI (unrar-free, unrar ou 7-Zip) instalado " +
        "no ambiente do sistema, e nenhum foi encontrado. Se você controla o servidor, instale um deles " +
        "(ex.: `apt-get install unrar-free`) para poder inspecionar arquivos .rar.",
      error: "RAR reader CLI binary not available on system",
    };
  }

  try {
    let entries: string[];
    if (reader.cmd === "7z" || reader.cmd === "7za") {
      const output = execFileSync(reader.cmd, ["l", "-ba", "-slt", inputPath], {
        encoding: "utf-8",
        maxBuffer: 64 * 1024 * 1024,
      });
      entries = output
        .split(/\r?\n/)
        .filter((line) => line.startsWith("Path = "))
        .map((line) => line.slice("Path = ".length).trim())
        .filter((p) => p && p !== inputPath);
    } else if (reader.cmd === "unrar-free") {
      // unrar-free tem sintaxe GNU-style própria (--list), diferente do
      // `unrar` proprietário — ver parseUnrarFreeListing acima.
      const output = execFileSync(reader.cmd, ["--list", inputPath], {
        encoding: "utf-8",
        maxBuffer: 64 * 1024 * 1024,
      });
      entries = parseUnrarFreeListing(output);
    } else {
      // unrar (proprietário) ou outro binário compatível com essa sintaxe
      // clássica: "lb" = bare list, um nome de arquivo por linha.
      const output = execFileSync(reader.cmd, ["lb", inputPath], {
        encoding: "utf-8",
        maxBuffer: 64 * 1024 * 1024,
      });
      entries = output
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
    }
    return {
      success: true,
      entries,
      message: `Arquivo contém ${entries.length} entrada(s) (lido via ${reader.name}).`,
    };
  } catch (err) {
    return {
      success: false,
      entries: [],
      message: `Falha ao ler entradas do arquivo .rar: ${err instanceof Error ? err.message : String(err)}`,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Extrai um arquivo .rar de verdade via CLI (unrar-free/unrar/7z). Mesma
 * limitação/motivação de `listRarEntries` — `extractZipArchive` (adm-zip)
 * não sabe extrair RAR.
 */
export function extractRarArchive(options: CompressionExtractOptions): CompressionOperationResult {
  const { inputPath, targetDir } = options;

  if (!existsSync(inputPath)) {
    return {
      success: false,
      filesProcessed: [],
      missingFiles: [inputPath],
      message: `Arquivo não encontrado: ${inputPath}`,
      error: `File not found: ${inputPath}`,
      format: "rar",
    };
  }

  const reader = detectRarReaderCli();
  if (!reader) {
    return {
      success: false,
      filesProcessed: [],
      missingFiles: [],
      message:
        "A extração de arquivos .rar reais requer um utilitário CLI (unrar-free, unrar ou 7-Zip) instalado " +
        "no ambiente do sistema, e nenhum foi encontrado.",
      error: "RAR reader CLI binary not available on system",
      format: "rar",
    };
  }

  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true });
  }

  try {
    if (reader.cmd === "7z" || reader.cmd === "7za") {
      execFileSync(reader.cmd, ["x", inputPath, `-o${targetDir}`, "-y"], { stdio: "pipe", maxBuffer: 64 * 1024 * 1024 });
    } else if (reader.cmd === "unrar-free") {
      // unrar-free: sintaxe GNU-style própria — "-f" sobrescreve arquivos
      // existentes, o destino é o último argumento posicional.
      execFileSync(reader.cmd, ["-f", inputPath, targetDir], { stdio: "pipe", maxBuffer: 64 * 1024 * 1024 });
    } else {
      // unrar (proprietário): "x" extrai preservando estrutura de pastas.
      execFileSync(reader.cmd, ["x", "-y", inputPath, `${targetDir}/`], { stdio: "pipe", maxBuffer: 64 * 1024 * 1024 });
    }

    return {
      success: true,
      outputPath: targetDir,
      filesProcessed: [inputPath],
      missingFiles: [],
      message: `Arquivo .rar extraído com sucesso via ${reader.name} em ${targetDir}.`,
      format: "rar",
    };
  } catch (err) {
    return {
      success: false,
      filesProcessed: [],
      missingFiles: [],
      message: `Falha ao extrair arquivo .rar: ${err instanceof Error ? err.message : String(err)}`,
      error: err instanceof Error ? err.message : String(err),
      format: "rar",
    };
  }
}
