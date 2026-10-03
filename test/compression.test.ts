import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  createZipArchive,
  createRarArchive,
  extractZipArchive,
  listZipEntries,
} from "../src/lib/compression.js";
import { CompressionTool } from "../src/adaptive/tools/compressionTool.js";
import { DEFAULT_SECURITY_POLICY } from "../src/adaptive/tools/security.js";

const TEST_DIR = join(process.cwd(), "tmp_test_compression");

describe("Módulo de Compactação (.zip / .rar)", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });
    writeFileSync(join(TEST_DIR, "doc1.txt"), "Conteudo do documento 1", "utf-8");
    writeFileSync(join(TEST_DIR, "doc2.txt"), "Conteudo do documento 2", "utf-8");
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  it("cria um arquivo .zip com sucesso contendo múltiplos arquivos", () => {
    const zipPath = join(TEST_DIR, "pacote.zip");
    const result = createZipArchive({
      outputPath: zipPath,
      sourcePaths: [join(TEST_DIR, "doc1.txt"), join(TEST_DIR, "doc2.txt")],
    });

    expect(result.success).toBe(true);
    expect(result.format).toBe("zip");
    expect(existsSync(zipPath)).toBe(true);
    expect(result.filesProcessed).toHaveLength(2);
  });

  it("lista e extrai o conteúdo de um arquivo .zip", () => {
    const zipPath = join(TEST_DIR, "pacote.zip");
    createZipArchive({
      outputPath: zipPath,
      sourcePaths: [join(TEST_DIR, "doc1.txt"), join(TEST_DIR, "doc2.txt")],
    });

    const listRes = listZipEntries(zipPath);
    expect(listRes.success).toBe(true);
    expect(listRes.entries).toContain("doc1.txt");
    expect(listRes.entries).toContain("doc2.txt");

    const outDir = join(TEST_DIR, "extraido");
    const extractRes = extractZipArchive({ inputPath: zipPath, targetDir: outDir });
    expect(extractRes.success).toBe(true);
    expect(existsSync(join(outDir, "doc1.txt"))).toBe(true);
    expect(existsSync(join(outDir, "doc2.txt"))).toBe(true);
  });

  it("trata requisição de .rar retornando resultado estruturado (CLI ou fallback explicativo)", () => {
    const rarPath = join(TEST_DIR, "pacote.rar");
    const result = createRarArchive({
      outputPath: rarPath,
      sourcePaths: [join(TEST_DIR, "doc1.txt")],
    });

    expect(result.format).toBe("rar");
    if (!result.success) {
      expect(result.message).toContain("rar");
      expect(result.error).toBeDefined();
    }
  });

  it("executa a CompressionTool via ToolRegistry interface para a ação zip", async () => {
    const tool = new CompressionTool({ ...DEFAULT_SECURITY_POLICY, fsRoot: process.cwd() });
    const zipPath = join(TEST_DIR, "tool_pacote.zip");

    const res = await tool.execute({
      action: "zip",
      outputPath: zipPath,
      sourcePaths: [join(TEST_DIR, "doc1.txt")],
    });

    expect(res.success).toBe(true);
    expect(res.exitCode).toBe(0);
    expect(res.filesChanged).toContain(zipPath);
    expect(res.metadata.operation).toBe("zip");
  });
});
