import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Jimp } from "jimp";
import { editImage, prepareMediaPayload, type WhatsAppMediaPayload } from "../src/lib/imageProcessor.js";
import { ImageTool } from "../src/adaptive/tools/imageTool.js";
import { DEFAULT_SECURITY_POLICY } from "../src/adaptive/tools/security.js";

const TEST_DIR = join(process.cwd(), "tmp_test_image");

describe("Módulo de Processamento e Envio de Imagens", () => {
  let sampleImgPath: string;

  beforeEach(async () => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });

    sampleImgPath = join(TEST_DIR, "sample.png");
    // Cria uma imagem simples 100x100 em memória com Jimp
    const img = new Jimp({ width: 100, height: 100, color: 0xff0000ff });
    await img.write(sampleImgPath as `${string}.${string}`);
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  it("redimensiona e aplica filtro de escala de cinza em uma imagem", async () => {
    const outPath = join(TEST_DIR, "edited.png");
    const result = await editImage(sampleImgPath, outPath, {
      resize: { width: 50, height: 50 },
      grayscale: true,
    });

    expect(result.success).toBe(true);
    expect(existsSync(outPath)).toBe(true);
    expect(result.dimensions?.width).toBe(50);
    expect(result.dimensions?.height).toBe(50);
  });

  it("gera payload de mídia estruturado para o canal WhatsApp", async () => {
    const payload = await prepareMediaPayload(sampleImgPath, "whatsapp", {
      caption: "Foto de teste",
    });

    // Narrowing explícito: prepareMediaPayload retorna a união MediaPayload
    // (WhatsApp | Telegram); a chamada com "whatsapp" garante isso em
    // runtime, mas o TS não estreita o retorno a partir de um argumento
    // literal sem overloads — daí o `if` abaixo em vez de um `as`.
    if (payload.channel !== "whatsapp") {
      throw new Error("esperava um payload do canal whatsapp");
    }
    const whatsappPayload: WhatsAppMediaPayload = payload;

    expect(whatsappPayload.channel).toBe("whatsapp");
    expect(whatsappPayload.mediaType).toBe("image");
    expect(whatsappPayload.mimetype).toBe("image/png");
    expect(whatsappPayload.caption).toBe("Foto de teste");
    expect(typeof whatsappPayload.data).toBe("string");
    expect(whatsappPayload.data.length).toBeGreaterThan(0);
  });

  it("gera payload de mídia estruturado para o canal Telegram", async () => {
    const payload = await prepareMediaPayload(sampleImgPath, "telegram", {
      caption: "Foto para Telegram",
    });

    expect(payload.channel).toBe("telegram");
    expect(payload.mediaType).toBe("photo");
    expect(payload.photo).toContain("data:image/png;base64,");
    expect(payload.dimensions.width).toBe(100);
  });

  it("executa a ImageTool via ToolRegistry interface para editar e preparar envio", async () => {
    const tool = new ImageTool({ ...DEFAULT_SECURITY_POLICY, fsRoot: process.cwd() });

    const editRes = await tool.execute({
      action: "edit",
      inputPath: sampleImgPath,
      outputPath: join(TEST_DIR, "tool_edited.jpeg"),
      operations: {
        resize: { width: 80, height: 80 },
        format: "jpeg",
      },
    });

    expect(editRes.success).toBe(true);
    expect(editRes.metadata.operation).toBe("edit");

    const sendRes = await tool.execute({
      action: "prepare_send",
      inputPath: sampleImgPath,
      channel: "whatsapp",
      caption: "Tool Send Test",
    });

    expect(sendRes.success).toBe(true);
    expect(sendRes.metadata.operation).toBe("prepare_send");
    expect(sendRes.metadata.channel).toBe("whatsapp");
  });
});
