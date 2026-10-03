/**
 * Fase 6 — ToolRegistry.
 *
 * Camada de abstração para execução de ações. O autonomous loop não faz chamadas
 * diretas de filesystem/shell. Tudo passa por tools registradas aqui.
 *
 * Cada tool possui: nome, descrição, schema de entrada, execução e resultado
 * estruturado (ToolResult). Toda tool call é registrada para auditoria.
 *
 * Segurança:
 * - Shell: lista de comandos permitidos/bloqueados configurável.
 * - Filesystem: restrict ao DATA_DIR ou diretório de trabalho.
 * - HTTP: apenas métodos GET/POST, URL configurável.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { execSync } from "node:child_process";
import { z } from "zod";

import type { Tool, ToolResult } from "../types.js";
import { DocumentTool } from "./document.js";
import { CompressionTool } from "./compressionTool.js";
import { ImageTool } from "./imageTool.js";
import { ProjectTool } from "./projectTool.js";
import {
  getDataDir,
  resolveSafePath,
  type SecurityPolicy,
  DEFAULT_SECURITY_POLICY,
} from "./security.js";

// Reexportados para manter compatibilidade com quem já importa daqui.
export { getDataDir, resolveSafePath, DEFAULT_SECURITY_POLICY };
export type { SecurityPolicy };

/**
 * Raiz de trabalho onde o agente opera tools de filesystem/shell/http.
 *
 * O FilesystemTool restringe escrita ao `fsRoot` do security policy. Para que o
 * agente crie arquivos DE VERDADE no diretório que o usuário espera, o registry
 * criado pelo runtime usa ESTA raiz (e não `~/.axon`), que por padrão é o
 * diretório de trabalho do processo (cwd) — o "workspace". Em Docker, o
 * `WORKDIR` é `/app`, então o agente cria arquivos lá. Configurável via
 * `AXON_WORKSPACE`, para que o operador eleja um volume seguros por vez de o cwd.
 */
export function getWorkspaceRoot(): string {
  const v = process.env.AXON_WORKSPACE?.trim();
  if (v) return v;
  return process.cwd();
}

// ─── Schemas de entrada ─────────────────────────────────────────────────

export const FileReadInput = z.object({
  path: z.string().min(1),
  encoding: z.enum(["utf-8", "base64"]).optional().default("utf-8"),
});

export const FileWriteInput = z.object({
  path: z.string().min(1),
  content: z.string(),
  encoding: z.enum(["utf-8", "base64"]).optional().default("utf-8"),
});

export const FileListInput = z.object({
  path: z.string().min(1),
  recursive: z.boolean().optional().default(false),
});

export const ShellInput = z.object({
  command: z.string().min(1).max(2000),
  cwd: z.string().optional(),
  timeoutMs: z.number().int().positive().max(60_000).optional().default(30_000),
});

export const HttpInput = z.object({
  url: z.string().url(),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional().default("GET"),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.string().optional(),
  timeoutMs: z.number().int().positive().max(60_000).optional().default(30_000),
});

export type FileReadInput = z.infer<typeof FileReadInput>;
export type FileWriteInput = z.infer<typeof FileWriteInput>;
export type FileListInput = z.infer<typeof FileListInput>;
export type ShellInput = z.infer<typeof ShellInput>;
export type HttpInput = z.infer<typeof HttpInput>;

// ─── Security Policy ──────────────────────────────────────────────────────
// (definida em ./security.ts — ver import/reexport no topo do arquivo)

// ─── Filesystem Tool ───────────────────────────────────────────────────

export class FilesystemTool implements Tool<FileReadInput | FileWriteInput | FileListInput> {
  readonly name = "filesystem";
  readonly description = "Read, write, and list files with security policy enforcement.";

  constructor(private readonly security: SecurityPolicy = DEFAULT_SECURITY_POLICY) {}

  async execute(input: FileReadInput | FileWriteInput | FileListInput): Promise<ToolResult> {
    const start = performance.now();

    // Type-safe routing based on input shape
    const writeInput = "content" in input;
    const listInput = "recursive" in input && !writeInput;

    try {
      if (writeInput) {
        return this.handleWrite(input, start);
      }
      if (listInput) {
        return this.handleList(input, start);
      }
      // Narrow type to FileReadInput for handleRead (TS cannot narrow the union
      // here due to the Record<"content", unknown> intersection in FileWriteInput)
      const readInput = input as FileReadInput;
      return this.handleRead(readInput, start);
    } catch (error) {
      const durationMs = performance.now() - start;
      return {
        success: false,
        output: null,
        error: error instanceof Error ? error.message : String(error),
        exitCode: 1,
        durationMs,
        filesChanged: [],
        metadata: {},
      };
    }
  }

  private safePath(path: string): string {
    return resolveSafePath(path, this.security.fsRoot);
  }

  private handleWrite(input: FileWriteInput, start: number): ToolResult {
    const filePath = this.safePath(input.path);

    try {
      const dir = join(filePath, "..");
      mkdirSync(dir, { recursive: true });
      writeFileSync(filePath, input.content, input.encoding);
    } catch (error) {
      const durationMs = performance.now() - start;
      return {
        success: false,
        output: null,
        error: error instanceof Error ? error.message : String(error),
        exitCode: 1,
        durationMs,
        filesChanged: [filePath],
        metadata: { operation: "write", path: filePath },
      };
    }

    const durationMs = performance.now() - start;
    return {
      success: true,
      output: `Written ${input.content.length} bytes to ${filePath}`,
      error: null,
      exitCode: 0,
      durationMs,
      filesChanged: [filePath],
      metadata: { operation: "write", path: filePath, bytes: input.content.length },
    };
  }

  private handleRead(input: FileReadInput, start: number): ToolResult {
    const filePath = this.safePath(input.path);

    if (!existsSync(filePath)) {
      return {
        success: false,
        output: null,
        error: `File not found: ${filePath}`,
        exitCode: 1,
        durationMs: performance.now() - start,
        filesChanged: [],
        metadata: { operation: "read", path: filePath },
      };
    }

    try {
      const content = readFileSync(filePath, input.encoding === "base64" ? "base64" : "utf-8");
      const stats = statSync(filePath);

      const durationMs = performance.now() - start;
      return {
        success: true,
        output: content,
        error: null,
        exitCode: 0,
        durationMs,
        filesChanged: [],
        metadata: {
          operation: "read",
          path: filePath,
          size: stats.size,
          encoding: input.encoding,
        },
      };
    } catch (error) {
      return {
        success: false,
        output: null,
        error: error instanceof Error ? error.message : String(error),
        exitCode: 1,
        durationMs: performance.now() - start,
        filesChanged: [],
        metadata: { operation: "read", path: filePath },
      };
    }
  }

  private handleList(input: FileListInput, start: number): ToolResult {
    const dirPath = this.safePath(input.path);

    if (!existsSync(dirPath)) {
      return {
        success: false,
        output: null,
        error: `Directory not found: ${dirPath}`,
        exitCode: 1,
        durationMs: performance.now() - start,
        filesChanged: [],
        metadata: { operation: "list", path: dirPath },
      };
    }

    try {
      const entries = input.recursive
        ? collectEntries(dirPath, dirPath, 2000)
        : readdirSync(dirPath, { withFileTypes: true }).map((entry) => ({
            path: entry.name,
            type: entry.isDirectory() ? "directory" : "file",
          }));
      const durationMs = performance.now() - start;

      return {
        success: true,
        output: JSON.stringify({ tool: "filesystem", action: "list", path: dirPath, entries }),
        error: null,
        exitCode: 0,
        durationMs,
        filesChanged: [],
        metadata: { operation: "list", path: dirPath, count: entries.length, recursive: input.recursive },
      };
    } catch (error) {
      return {
        success: false,
        output: null,
        error: error instanceof Error ? error.message : String(error),
        exitCode: 1,
        durationMs: performance.now() - start,
        filesChanged: [],
        metadata: { operation: "list", path: dirPath },
      };
    }
  }
}

function collectEntries(root: string, current: string, remaining: number): Array<{ path: string; type: "file" | "directory" }> {
  if (remaining <= 0) return [];
  const ignored = new Set([".git", "node_modules", "dist"]);
  const result: Array<{ path: string; type: "file" | "directory" }> = [];

  for (const entry of readdirSync(current, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const absolute = join(current, entry.name);
    const relativePath = relative(root, absolute) || entry.name;
    const type = entry.isDirectory() ? "directory" : "file";
    result.push({ path: relativePath, type });
    if (type === "directory" && result.length < remaining) {
      result.push(...collectEntries(root, absolute, remaining - result.length));
    }
    if (result.length >= remaining) break;
  }

  return result;
}

// ─── Shell Tool ─────────────────────────────────────────────────────────

export class ShellTool implements Tool<ShellInput> {
  readonly name = "shell";
  readonly description = "Execute shell commands with security policy enforcement.";

  constructor(private readonly security: SecurityPolicy = DEFAULT_SECURITY_POLICY) {}

  async execute(input: ShellInput): Promise<ToolResult> {
    const start = performance.now();

    const { command, cwd, timeoutMs } = input;

    // Security check: blocked patterns
    for (const pattern of this.security.blockedShellPatterns) {
      if (pattern.test(command)) {
        const patternStr = pattern.source;
        const issue = `Blocked by security policy: command matches pattern ${patternStr}`;
        return {
          success: false,
          output: null,
          error: issue,
          exitCode: 126, // permission denied-like
          durationMs: performance.now() - start,
          filesChanged: [],
          metadata: { command, blockedPattern: patternStr },
        };
      }
    }

    // Security check: allowed commands whitelist
    if (this.security.allowedShellCommands) {
      const cmdBase = command.trim().split(/\s+/)[0] ?? "";
      if (!this.security.allowedShellCommands.includes(cmdBase)) {
        return {
          success: false,
          output: null,
          error: `Command '${cmdBase}' is not in the allowed list`,
          exitCode: 126,
          durationMs: performance.now() - start,
          filesChanged: [],
          metadata: { command, reason: "not_in_whitelist" },
        };
      }
    }

    try {
      const result = execSync(command, {
        cwd: cwd ?? process.cwd(),
        timeout: timeoutMs,
        encoding: "utf-8",
        maxBuffer: 1024 * 1024, // 1MB max output
        stdio: ["pipe", "pipe", "pipe"],
      });

      const durationMs = performance.now() - start;
      return {
        success: true,
        output: result.trim(),
        error: null,
        exitCode: 0,
        durationMs,
        filesChanged: [],
        metadata: { command, cwd },
      };
    } catch (error) {
      const isError = error instanceof Error;
      const exitCode = isError ? (error as Error & { status?: number; code?: string }).status : 1;
      const errorMessage = isError ? error.message : String(error);
      let stderr = "";
      let stdout = "";
      if (isError) {
        const err = error as Error & { stderr?: string | Buffer; stdout?: string | Buffer };
        stderr = err.stderr !== undefined ? err.stderr.toString() : "";
        stdout = err.stdout !== undefined ? err.stdout.toString() : "";
      }
      const msg = stderr || stdout || errorMessage;

      const durationMs = performance.now() - start;
      return {
        success: false,
        output: stdout || null,
        error: msg,
        exitCode: typeof exitCode === "number" ? exitCode : 1,
        durationMs,
        filesChanged: [],
        metadata: { command, exitCode, timedOut: false },
      };
    }
  }
}

// ─── HTTP Tool ──────────────────────────────────────────────────────────

export class HttpTool implements Tool<HttpInput> {
  readonly name = "http";
  readonly description = "Make HTTP requests to external APIs.";

  constructor(private readonly security: SecurityPolicy = DEFAULT_SECURITY_POLICY) {}

  async execute(input: HttpInput): Promise<ToolResult> {
    const start = performance.now();

    // Security check: allowed hosts
    if (this.security.allowedHosts) {
      try {
        const url = new URL(input.url);
        if (!this.security.allowedHosts.includes(url.hostname)) {
          return {
            success: false,
            output: null,
            error: `Host '${url.hostname}' is not in allowed hosts list`,
            exitCode: 1,
            durationMs: performance.now() - start,
            filesChanged: [],
            metadata: { url: input.url, reason: "host_blocked" },
          };
        }
      } catch {
        return {
          success: false,
          output: null,
          error: `Invalid URL: ${input.url}`,
          exitCode: 1,
          durationMs: performance.now() - start,
          filesChanged: [],
          metadata: { url: input.url, reason: "invalid_url" },
        };
      }
    }

    try {
      const headers = new Headers();
      if (input.body) {
        headers.set("Content-Type", "application/json");
      }
      if (input.headers) {
        for (const [key, value] of Object.entries(input.headers)) {
          headers.set(key, String(value));
        }
      }

      const response = await fetch(input.url, {
        method: input.method,
        headers,
        body: input.body,
        signal: AbortSignal.timeout(input.timeoutMs),
      });

      const text = await response.text();
      const durationMs = performance.now() - start;

      return {
        success: response.ok,
        output: text,
        error: response.ok ? null : `HTTP ${response.status}: ${response.statusText}`,
        exitCode: response.ok ? 0 : response.status,
        durationMs,
        filesChanged: [],
        metadata: {
          url: input.url,
          method: input.method,
          status: response.status,
          statusText: response.statusText,
        },
      };
    } catch (error) {
      const durationMs = performance.now() - start;
      return {
        success: false,
        output: null,
        error: error instanceof Error ? error.message : String(error),
        exitCode: 1,
        durationMs,
        filesChanged: [],
        metadata: { url: input.url, method: input.method },
      };
    }
  }
}

// ─── Tool Registry ──────────────────────────────────────────────────────

export interface ToolCallRecord {
  id: string;
  toolName: string;
  input: unknown;
  result: ToolResult;
  timestamp: number;
  durationMs: number;
  tokenCost?: { input: number; output: number };
}

export interface ToolRegistryMetrics {
  totalCalls: number;
  totalDurationMs: number;
  totalCostUsd: number;
  errors: number;
  byTool: Record<string, { calls: number; durationMs: number; errors: number }>;
}

export interface ToolRegistry {
  /** Registra uma tool. */
  register<TInput>(tool: Tool<TInput>): void;
  /** Executa uma tool pelo nome. */
  execute<TInput>(name: string, input: TInput): Promise<ToolResult>;
  /** Lista tools registradas. */
  list(): string[];
  /** Pega uma tool pelo nome. */
  get<TInput>(name: string): Tool<TInput> | undefined;
  /** Histórico de tool calls. */
  getHistory(): ToolCallRecord[];
  /** Métricas agregadas. */
  getMetrics(): ToolRegistryMetrics;
  /** Limpa o histórico (para testes). */
  clearHistory(): void;
}

export interface ToolRegistryOptions {
  security?: Partial<SecurityPolicy>;
  enableHistory?: boolean;
  maxHistorySize?: number;
}

export class DefaultToolRegistry implements ToolRegistry {
  private tools = new Map<string, Tool<unknown>>();
  private history: ToolCallRecord[] = [];
  private enableHistory: boolean;
  private maxHistorySize: number;

  constructor(options?: ToolRegistryOptions) {
    this.enableHistory = options?.enableHistory ?? true;
    this.maxHistorySize = options?.maxHistorySize ?? 1000;
  }

  register<TInput>(tool: Tool<TInput>): void {
    this.tools.set(tool.name, tool);
  }

  async execute<TInput>(name: string, input: TInput): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        success: false,
        output: null,
        error: `Tool '${name}' not registered`,
        exitCode: 1,
        durationMs: 0,
        filesChanged: [],
        metadata: { toolName: name, reason: "not_registered" },
      };
    }

    const start = performance.now();
    let result: ToolResult;

    try {
      result = await tool.execute(input);
    } catch (error) {
      result = {
        success: false,
        output: null,
        error: error instanceof Error ? error.message : String(error),
        exitCode: 1,
        durationMs: performance.now() - start,
        filesChanged: [],
        metadata: { toolName: name, reason: "exception" },
      };
    }

    const durationMs = Math.max(performance.now() - start, 0.01);
    result.durationMs = durationMs;

    // Record history
    if (this.enableHistory) {
      const record: ToolCallRecord = {
        id: `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        toolName: name,
        input,
        result,
        timestamp: Date.now(),
        durationMs,
      };

      this.history.push(record);
      if (this.history.length > this.maxHistorySize) {
        this.history.shift();
      }
    }

    return result;
  }

  list(): string[] {
    return Array.from(this.tools.keys());
  }

  get<TInput>(name: string): Tool<TInput> | undefined {
    return this.tools.get(name);
  }

  getHistory(): ToolCallRecord[] {
    return [...this.history];
  }

  clearHistory(): void {
    this.history = [];
  }

  getMetrics(): ToolRegistryMetrics {
    const byTool: Record<string, { calls: number; durationMs: number; errors: number }> = {};
    let totalCalls = 0;
    let totalDurationMs = 0;
    const totalCostUsd = 0;
    let errors = 0;

    for (const record of this.history) {
      totalCalls++;
      totalDurationMs += record.durationMs;
      if (record.result.exitCode !== 0 && record.result.exitCode !== null) {
        errors++;
      }

      const entry = byTool[record.toolName] ?? { calls: 0, durationMs: 0, errors: 0 };
      entry.calls++;
      entry.durationMs += record.durationMs;
      if (record.result.exitCode !== 0 && record.result.exitCode !== null) {
        entry.errors++;
      }
      byTool[record.toolName] = entry;
    }

    return { totalCalls, totalDurationMs, totalCostUsd, errors, byTool };
  }
}

/** Cria um registry padrão com filesystem, shell e http registradas. */
export function createDefaultToolRegistry(
  options?: ToolRegistryOptions
): ToolRegistry {
  const registry = new DefaultToolRegistry(options);
  const security = { ...DEFAULT_SECURITY_POLICY, ...(options?.security ?? {}) };

  registry.register(new FilesystemTool(security));
  registry.register(new ShellTool(security));
  registry.register(new HttpTool(security));
  registry.register(new DocumentTool(security));
  registry.register(new CompressionTool(security));
  registry.register(new ImageTool(security));
  registry.register(new ProjectTool(security));

  return registry;
}

/** Cria um registry padrão com filesystem, shell e http registradas. (re-export) */

// Reexport types
export type { Tool, ToolResult } from "../types.js";
