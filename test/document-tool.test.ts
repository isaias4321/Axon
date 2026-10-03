import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AdmZip from "adm-zip";

import { DocumentTool } from "../src/adaptive/tools/document.js";
import { renderChartSvg } from "../src/adaptive/tools/charts.js";
import { buildToolInput } from "../src/adaptive/executor.js";
import { detectToolIntent } from "../src/adaptive/taskAnalyzer.js";
import type { PlanStep } from "../src/adaptive/types.js";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "axon-doctool-"));
}

function makeStep(description: string): PlanStep {
  return {
    id: "s1",
    index: 0,
    description,
    objective: description,
    capability: "execucao_ferramenta",
    dependencies: [],
    status: "pending",
    attempts: 0,
    maxAttempts: 3,
  };
}

describe("DocumentTool — zip", () => {
  it("cria um ZIP real com os arquivos-fonte pedidos", async () => {
    const dir = freshDir();
    writeFileSync(join(dir, "a.txt"), "conteudo A");
    writeFileSync(join(dir, "b.txt"), "conteudo B");
    const tool = new DocumentTool({ blockedShellPatterns: [], allowedShellCommands: null, fsRoot: dir, allowedHosts: null });

    const result = await tool.execute({ action: "zip", outputPath: "pacote.zip", sourcePaths: ["a.txt", "b.txt"] });

    expect(result.success).toBe(true);
    expect(existsSync(join(dir, "pacote.zip"))).toBe(true);
    const zip = new AdmZip(join(dir, "pacote.zip"));
    const names = zip.getEntries().map((e) => e.entryName).sort();
    expect(names).toEqual(["a.txt", "b.txt"]);
    expect(zip.readAsText("a.txt")).toBe("conteudo A");
  });

  it("não trava a operação inteira quando um arquivo-fonte não existe — reporta e segue com os demais", async () => {
    const dir = freshDir();
    writeFileSync(join(dir, "a.txt"), "conteudo A");
    const tool = new DocumentTool({ blockedShellPatterns: [], allowedShellCommands: null, fsRoot: dir, allowedHosts: null });

    const result = await tool.execute({ action: "zip", outputPath: "pacote.zip", sourcePaths: ["a.txt", "nao-existe.txt"] });

    expect(result.success).toBe(true);
    expect(result.metadata["missing"]).toEqual(["nao-existe.txt"]);
    expect((result.metadata["entries"] as string[])).toEqual(["a.txt"]);
  });

  it("bloqueia path traversal no destino do zip", async () => {
    const dir = freshDir();
    const tool = new DocumentTool({ blockedShellPatterns: [], allowedShellCommands: null, fsRoot: dir, allowedHosts: null });

    const result = await tool.execute({ action: "zip", outputPath: "../fora.zip", sourcePaths: ["a.txt"] });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/escapes allowed root/);
  });

  it("bloqueia path traversal num arquivo-fonte", async () => {
    const dir = freshDir();
    const tool = new DocumentTool({ blockedShellPatterns: [], allowedShellCommands: null, fsRoot: dir, allowedHosts: null });

    const result = await tool.execute({ action: "zip", outputPath: "pacote.zip", sourcePaths: ["../../etc/passwd"] });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/escapes allowed root/);
  });
});

describe("DocumentTool — pdf", () => {
  it("cria um PDF real e não vazado (arquivo binário PDF válido)", async () => {
    const dir = freshDir();
    const tool = new DocumentTool({ blockedShellPatterns: [], allowedShellCommands: null, fsRoot: dir, allowedHosts: null });

    const result = await tool.execute({
      action: "pdf",
      outputPath: "relatorio.pdf",
      title: "Relatório",
      content: "Conteúdo do relatório de teste.",
    });

    expect(result.success).toBe(true);
    const bytes = readFileSync(join(dir, "relatorio.pdf"));
    expect(bytes.subarray(0, 4).toString("ascii")).toBe("%PDF"); // assinatura real de um PDF
    expect(bytes.length).toBeGreaterThan(200);
  });

  it("bloqueia path traversal no destino do pdf", async () => {
    const dir = freshDir();
    const tool = new DocumentTool({ blockedShellPatterns: [], allowedShellCommands: null, fsRoot: dir, allowedHosts: null });

    const result = await tool.execute({ action: "pdf", outputPath: "../fora.pdf", content: "hack" });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/escapes allowed root/);
  });
});

describe("DocumentTool — chart (SVG, sem dependência nativa)", () => {
  it("gera SVG válido para bar/pie/flowchart com os rótulos pedidos", async () => {
    const dir = freshDir();
    const tool = new DocumentTool({ blockedShellPatterns: [], allowedShellCommands: null, fsRoot: dir, allowedHosts: null });

    for (const chartType of ["bar", "pie", "flowchart"] as const) {
      const result = await tool.execute({
        action: "chart",
        outputPath: `${chartType}.svg`,
        chartType,
        title: "Teste",
        data: [{ label: "Alfa", value: 10 }, { label: "Beta", value: 20 }],
      });
      expect(result.success).toBe(true);
      const svg = readFileSync(join(dir, `${chartType}.svg`), "utf-8");
      expect(svg.startsWith("<svg")).toBe(true);
      expect(svg).toContain("Alfa");
      expect(svg).toContain("Beta");
    }
  });

  it("renderChartSvg escapa XML nos rótulos (não gera SVG quebrado/injeção)", () => {
    const svg = renderChartSvg("bar", [{ label: "<script>alert(1)</script>", value: 5 }]);
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;script&gt;");
  });
});

describe("Extração de linguagem natural — zip/pdf/chart", () => {
  it("detectToolIntent reconhece pedidos de documento", () => {
    expect(detectToolIntent("Compacte a.txt e b.txt em pacote.zip")).toBe("document");
    expect(detectToolIntent("Crie um PDF com o relatório")).toBe("document");
    expect(detectToolIntent("Gere um gráfico de barras com as vendas")).toBe("document");
  });

  it("deriva um zip a partir de texto livre, ignorando palavras soltas sem extensão", () => {
    const task = "Compacte os arquivos a.txt e b.txt no arquivo pacote.zip";
    const result = buildToolInput("document", makeStep(task), task);
    expect(result).toEqual({
      success: true,
      action: "zip",
      value: { action: "zip", outputPath: "pacote.zip", sourcePaths: ["a.txt", "b.txt"] },
    });
  });

  it("deriva um pdf preservando prosa completa (não corta em 'em'/'para'/'com')", () => {
    const task =
      "Crie um PDF chamado relatorio.pdf com o título Relatório Mensal com o conteúdo: Vendas cresceram 20% em relação ao mês anterior.";
    const result = buildToolInput("document", makeStep(task), task);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value).toMatchObject({
        outputPath: "relatorio.pdf",
        title: "Relatório Mensal",
        content: "Vendas cresceram 20% em relação ao mês anterior.",
      });
    }
  });

  it("deriva um gráfico com pares rótulo:valor a partir de texto livre", () => {
    const task = "Gere um gráfico de barras chamado vendas.svg com os dados: Jan:120, Fev:90, Mar:150";
    const result = buildToolInput("document", makeStep(task), task);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value).toMatchObject({
        outputPath: "vendas.svg",
        chartType: "bar",
        data: [
          { label: "Jan", value: 120 },
          { label: "Fev", value: 90 },
          { label: "Mar", value: 150 },
        ],
      });
    }
  });

  it("deriva um fluxograma com só rótulos (sem valor) em ordem", () => {
    const task = "Gere um fluxograma chamado processo.svg com as etapas: Receber pedido, Validar pagamento, Enviar produto";
    const result = buildToolInput("document", makeStep(task), task);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value).toMatchObject({
        outputPath: "processo.svg",
        chartType: "flowchart",
        data: [{ label: "Receber pedido" }, { label: "Validar pagamento" }, { label: "Enviar produto" }],
      });
    }
  });

  it("REGRA READ-ONLY: 'NÃO crie nenhum pdf' nunca deriva uma ação de documento", () => {
    const task = "NÃO crie nenhum pdf. Apenas verifique se o arquivo existe.";
    const result = buildToolInput("document", makeStep(task), task);
    expect(result.success).toBe(false);
  });

  it("REGRA READ-ONLY: uma etapa que só MENCIONA zip/pdf num contexto de verificação não cria nada", () => {
    const task = "Verifique se existe algum arquivo .zip ou .pdf na pasta, sem criar nenhum novo.";
    const result = buildToolInput("document", makeStep(task), task);
    expect(result.success).toBe(false);
  });
});
