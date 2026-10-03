import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  detectArchiveFormat,
  parseUnrarFreeListing,
  listRarEntries,
  extractRarArchive,
} from "../src/lib/compression.js";

const TEST_DIR = join(process.cwd(), "tmp_test_rar_reading");

/**
 * Regressão real: um usuário enviou um .rar de verdade e pediu para o
 * agente descrever o conteúdo. `listZipEntries` (baseado em adm-zip, que só
 * entende ZIP) sempre falhava com um erro de "formato inválido" ao receber
 * um RAR de verdade — RAR e ZIP são formatos binários completamente
 * diferentes. Este arquivo cobre a solução: detecção do formato real pelos
 * bytes do arquivo + leitura via CLI livre (unrar-free) quando disponível.
 */
describe("detectArchiveFormat", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });
  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("identifica um ZIP de verdade pela assinatura mágica 'PK', mesmo com extensão .rar", () => {
    // Casa comum: usuário renomeia um .zip para .rar (ou vice-versa) sem
    // perceber. A detecção não deve confiar na extensão do nome.
    const fakeRarButActuallyZip = join(TEST_DIR, "disfarcado.rar");
    writeFileSync(fakeRarButActuallyZip, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]));
    expect(detectArchiveFormat(fakeRarButActuallyZip)).toBe("zip");
  });

  it("identifica um RAR de verdade pela assinatura mágica 'Rar!', mesmo com extensão .zip", () => {
    const fakeZipButActuallyRar = join(TEST_DIR, "disfarcado.zip");
    writeFileSync(fakeZipButActuallyRar, Buffer.from("Rar!\x1a\x07\x00extra-bytes"));
    expect(detectArchiveFormat(fakeZipButActuallyRar)).toBe("rar");
  });

  it("retorna 'unknown' para um arquivo que não é nem zip nem rar", () => {
    const plainText = join(TEST_DIR, "notas.txt");
    writeFileSync(plainText, "isso é só um texto qualquer, não é um arquivo compactado");
    expect(detectArchiveFormat(plainText)).toBe("unknown");
  });

  it("retorna 'unknown' para um caminho que não existe", () => {
    expect(detectArchiveFormat(join(TEST_DIR, "nao-existe.rar"))).toBe("unknown");
  });
});

describe("parseUnrarFreeListing", () => {
  it("extrai só os nomes de arquivo do formato verboso de duas linhas por entrada do unrar-free", () => {
    // Formato real observado rodando `unrar-free --list` (não existe modo
    // "bare"/só-nomes nessa reimplementação, diferente do unrar proprietário).
    const realisticOutput = [
      "",
      "unrar-free 0.1.3  Copyright (C) 2004  Ben Asselstine, Jeroen Dekkers",
      "",
      "",
      "RAR archive /tmp/exemplo.rar",
      "",
      "Pathname/Comment",
      "                  Size   Date   Time     Attr",
      "----------------------------------------------",
      " axon/.env",
      "                  2253 18-09-26 01:38   .....A",
      " axon/package.json",
      "                   980 18-09-26 01:38   .....A",
      " axon/src",
      "                     0 18-09-26 01:39   .D....",
      "----------------------------------------------",
      "3        3233",
    ].join("\n");

    const entries = parseUnrarFreeListing(realisticOutput);
    expect(entries).toEqual(["axon/.env", "axon/package.json", "axon/src"]);
  });

  it("retorna lista vazia quando a saída não tem o formato esperado (menos de 2 separadores)", () => {
    expect(parseUnrarFreeListing("saída inesperada sem separadores")).toEqual([]);
  });

  it("retorna lista vazia para saída vazia", () => {
    expect(parseUnrarFreeListing("")).toEqual([]);
  });
});

describe("listRarEntries / extractRarArchive — comportamento sem CLI disponível", () => {
  const originalPath = process.env.PATH;
  let existingFile: string;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    existingFile = join(TEST_DIR, "algum.rar");
    writeFileSync(existingFile, Buffer.from("Rar!\x1a\x07\x00fake-rar-bytes"));
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("listRarEntries reporta com clareza quando nenhum leitor de RAR está instalado", () => {
    // Esvazia o PATH para simular um ambiente sem unrar-free/unrar/7z —
    // mesmo cenário do Dockerfile ANTES da correção (nenhuma dessas
    // ferramentas era instalada na imagem).
    process.env.PATH = "";
    const res = listRarEntries(existingFile);
    expect(res.success).toBe(false);
    expect(res.error).toBe("RAR reader CLI binary not available on system");
    expect(res.message).toContain("unrar-free");
  });

  it("extractRarArchive reporta com clareza quando nenhum leitor de RAR está instalado", () => {
    process.env.PATH = "";
    const res = extractRarArchive({ inputPath: existingFile, targetDir: join(TEST_DIR, "saida") });
    expect(res.success).toBe(false);
    expect(res.error).toBe("RAR reader CLI binary not available on system");
    expect(res.format).toBe("rar");
  });

  it("listRarEntries reporta arquivo não encontrado antes mesmo de checar o CLI", () => {
    const res = listRarEntries("/caminho/que/nao/existe.rar");
    expect(res.success).toBe(false);
    expect(res.error).toContain("File not found");
  });
});
