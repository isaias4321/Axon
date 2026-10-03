import { describe, expect, it } from "vitest";
import {
  createDefaultToolRegistry,
  DefaultToolRegistry,
  FilesystemTool,
  ShellTool,
  HttpTool,
} from "../src/adaptive/tools/registry.js";
import os from "node:os";
import path from "node:path";

describe("ToolRegistry", () => {
  it("registra e executa tools", async () => {
    const registry = new DefaultToolRegistry();
    registry.register(new FilesystemTool({
      blockedShellPatterns: [],
      allowedShellCommands: null,
      fsRoot: null,
      allowedHosts: null,
    }));

    const result = await registry.execute("filesystem", {
      path: path.join(os.tmpdir(), `test-${Date.now()}.txt`),
      content: "hello",
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("Written");
  });

  it("cria registry padrão com filesystem, shell e http", () => {
    const registry = createDefaultToolRegistry();
    const tools = registry.list();
    expect(tools).toContain("filesystem");
    expect(tools).toContain("shell");
    expect(tools).toContain("http");
  });

  it("retorna erro para tool não registrada", async () => {
    const registry = new DefaultToolRegistry();
    const result = await registry.execute("nonexistent", {});
    expect(result.success).toBe(false);
    expect(result.error).toContain("not registered");
  });

  it("registra histórico de tool calls", async () => {
    const registry = new DefaultToolRegistry();
    registry.register(new FilesystemTool());

    await registry.execute("filesystem", {
      path: path.join(os.tmpdir(), `test-${Date.now()}.txt`),
      content: "data",
    });

    const history = registry.getHistory();
    expect(history).toHaveLength(1);
    expect(history[0]!.toolName).toBe("filesystem");
  });
});

describe("ShellTool Security", () => {
  it("bloqueia comandos perigosos", async () => {
    const tool = new ShellTool();
    const result = await tool.execute({ command: "rm -rf /" });
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(126);
  });

  it("permite comandos seguros (echo)", async () => {
    const tool = new ShellTool();
    const result = await tool.execute({ command: "echo hello" });
    expect(result.success).toBe(true);
    expect(result.output).toContain("hello");
  });

  it("respeita whitelist de comandos", async () => {
    const tool = new ShellTool({
      blockedShellPatterns: [],
      allowedShellCommands: ["echo"],
      fsRoot: null,
      allowedHosts: null,
    });
    const good = await tool.execute({ command: "echo ok" });
    const bad = await tool.execute({ command: "ls" });
    expect(good.success).toBe(true);
    expect(bad.success).toBe(false);
  });
});

describe("HttpTool Security", () => {
  it("bloqueia hosts não permitidos", async () => {
    const tool = new HttpTool({
      blockedShellPatterns: [],
      allowedShellCommands: null,
      fsRoot: null,
      allowedHosts: ["api.github.com"],
    });
    const result = await tool.execute({ url: "https://evil.com/data" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("not in allowed hosts");
  });
});
