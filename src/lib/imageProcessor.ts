/**
 * Módulo de processamento de imagem e preparação de payload para WhatsApp / Telegram.
 * Utiliza Jimp para edição nativa em JavaScript sem dependências binárias C++.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname } from "node:path";
import { Jimp } from "jimp";
import { z } from "zod";

export const ImageResizeSchema = z.object({
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
});

export const ImageCropSchema = z.object({
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

export const ImageFlipSchema = z.object({
  horizontal: z.boolean().optional(),
  vertical: z.boolean().optional(),
});

export const ImageOperationsSchema = z.object({
  resize: ImageResizeSchema.optional(),
  crop: ImageCropSchema.optional(),
  rotate: z.number().optional(),
  grayscale: z.boolean().optional(),
  sepia: z.boolean().optional(),
  blur: z.number().positive().optional(),
  invert: z.boolean().optional(),
  flip: ImageFlipSchema.optional(),
  format: z.enum(["png", "jpeg", "webp", "bmp"]).optional(),
  quality: z.number().int().min(1).max(100).optional(),
});

export type ImageOperations = z.infer<typeof ImageOperationsSchema>;

export interface ImageEditResult {
  success: boolean;
  outputPath?: string;
  dimensions?: { width: number; height: number };
  bytes?: number;
  mimeType?: string;
  message: string;
  error?: string;
}

export interface WhatsAppMediaPayload {
  channel: "whatsapp";
  mediaType: "image";
  mimetype: string;
  data: string; // Base64 sem prefixo
  filename: string;
  caption?: string;
  fileSize: number;
  dimensions: { width: number; height: number };
}

export interface TelegramMediaPayload {
  channel: "telegram";
  mediaType: "photo";
  photo: string; // Base64 data URL ou caminho de arquivo
  caption?: string;
  mime_type: string;
  filename: string;
  fileSize: number;
  dimensions: { width: number; height: number };
}

export type MediaPayload = WhatsAppMediaPayload | TelegramMediaPayload;

/** Mapeia extensões de arquivos de imagem para mimeTypes correspondentes. */
export function getMimeTypeForFile(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  switch (ext) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".bmp":
      return "image/bmp";
    default:
      return "image/jpeg";
  }
}

/**
 * Edita uma imagem aplicando redimensionamento, corte, rotação, filtros ou alteração de formato.
 */
export async function editImage(
  inputPath: string,
  outputPath: string,
  operations: ImageOperations
): Promise<ImageEditResult> {
  if (!existsSync(inputPath)) {
    return {
      success: false,
      message:
        `Arquivo de imagem de entrada não encontrado: ${inputPath}. ` +
        "Esta ferramenta só EDITA imagens que já existem no workspace (redimensionar, " +
        "cortar, girar, aplicar filtro, converter formato) — ela não gera imagens novas " +
        "a partir de uma descrição em texto. Se você quer uma imagem nova gerada por IA, " +
        "essa capacidade não está disponível neste agente; envie/anexe uma imagem existente " +
        "para que ela possa ser editada.",
      error: "Input image file not found (esta tool só edita imagens existentes, não gera imagens novas a partir de texto)",
    };
  }

  try {
    const dir = dirname(outputPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const image = await Jimp.read(inputPath);

    // 1. Corte (Crop)
    if (operations.crop) {
      const { x, y, width, height } = operations.crop;
      image.crop({ x, y, w: width, h: height });
    }

    // 2. Redimensionar (Resize)
    if (operations.resize) {
      const targetW = operations.resize.width;
      const targetH = operations.resize.height;
      if (targetW || targetH) {
        const finalW = targetW ?? Math.round(image.width * ((targetH ?? image.height) / image.height));
        const finalH = targetH ?? Math.round(image.height * ((targetW ?? image.width) / image.width));
        image.resize({ w: finalW, h: finalH });
      }
    }

    // 3. Rotação
    if (typeof operations.rotate === "number" && operations.rotate !== 0) {
      image.rotate(operations.rotate);
    }

    // 4. Inverter eixo (Flip)
    if (operations.flip) {
      const horizontal = Boolean(operations.flip.horizontal);
      const vertical = Boolean(operations.flip.vertical);
      if (horizontal || vertical) {
        image.flip({ horizontal, vertical });
      }
    }

    // 5. Filtros
    if (operations.grayscale) {
      image.greyscale();
    }

    if (operations.sepia) {
      image.sepia();
    }

    if (operations.invert) {
      image.invert();
    }

    if (typeof operations.blur === "number" && operations.blur > 0) {
      image.blur(operations.blur);
    }

    // Determina o formato e mimeType de saída
    const targetFormat = operations.format ?? ((extname(outputPath).slice(1) as "png" | "jpeg" | "webp" | "bmp") || "jpeg");
    const mimeType = getMimeTypeForFormat(targetFormat);

    // Salva a imagem processada em disco
    await image.write(outputPath as `${string}.${string}`);

    const stats = statSync(outputPath);
    const width = image.width;
    const height = image.height;

    return {
      success: true,
      outputPath,
      dimensions: { width, height },
      bytes: stats.size,
      mimeType,
      message: `Imagem editada e salva com sucesso em ${outputPath} (${width}x${height}px, ${stats.size} bytes).`,
    };
  } catch (err) {
    return {
      success: false,
      message: `Erro ao processar imagem: ${err instanceof Error ? err.message : String(err)}`,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function getMimeTypeForFormat(format: string): string {
  switch (format.toLowerCase()) {
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "bmp":
      return "image/bmp";
    case "jpeg":
    case "jpg":
    default:
      return "image/jpeg";
  }
}

/**
 * Lê uma imagem do disco (ou buffer) e constrói o payload estruturado para envio no canal WhatsApp ou Telegram.
 */
export async function prepareMediaPayload(
  filePathOrBuffer: string | Buffer,
  channel: "whatsapp" | "telegram",
  options: { caption?: string; filename?: string } = {}
): Promise<MediaPayload> {
  let buffer: Buffer;
  let filename: string;
  let mimeType: string;
  let fileSize: number;

  if (typeof filePathOrBuffer === "string") {
    if (!existsSync(filePathOrBuffer)) {
      throw new Error(`Arquivo de imagem não encontrado: ${filePathOrBuffer}`);
    }
    buffer = readFileSync(filePathOrBuffer);
    filename = options.filename ?? basename(filePathOrBuffer);
    mimeType = getMimeTypeForFile(filePathOrBuffer);
    fileSize = statSync(filePathOrBuffer).size;
  } else {
    buffer = filePathOrBuffer;
    filename = options.filename ?? "image.jpg";
    mimeType = getMimeTypeForFormat(extname(filename).slice(1) || "jpeg");
    fileSize = buffer.length;
  }

  // Obter dimensões reais da imagem via Jimp
  let width = 800;
  let height = 600;
  try {
    const jimpImage = await Jimp.read(buffer);
    width = jimpImage.width;
    height = jimpImage.height;
  } catch {
    // Fallback se não for possível decodificar dimensões exatas
  }

  const base64Data = buffer.toString("base64");

  if (channel === "whatsapp") {
    return {
      channel: "whatsapp",
      mediaType: "image",
      mimetype: mimeType,
      data: base64Data,
      filename,
      caption: options.caption,
      fileSize,
      dimensions: { width, height },
    };
  }

  return {
    channel: "telegram",
    mediaType: "photo",
    photo: `data:${mimeType};base64,${base64Data}`,
    caption: options.caption,
    mime_type: mimeType,
    filename,
    fileSize,
    dimensions: { width, height },
  };
}
