/**
 * ImageTool — ferramenta para edição de imagens e preparação de payloads para WhatsApp/Telegram.
 */

import { z } from "zod";
import type { Tool, ToolResult } from "../types.js";
import type { SecurityPolicy } from "./security.js";
import { resolveSafePath } from "./security.js";
import {
  editImage,
  prepareMediaPayload,
  ImageOperationsSchema,
} from "../../lib/imageProcessor.js";

export const ImageEditInput = z.object({
  action: z.literal("edit"),
  inputPath: z.string().min(1),
  outputPath: z.string().min(1),
  operations: ImageOperationsSchema,
});

export const ImagePrepareSendInput = z.object({
  action: z.literal("prepare_send"),
  inputPath: z.string().min(1),
  channel: z.enum(["whatsapp", "telegram"]),
  caption: z.string().optional(),
});

export const ImageToolInput = z.discriminatedUnion("action", [
  ImageEditInput,
  ImagePrepareSendInput,
]);

export type ImageEditInput = z.infer<typeof ImageEditInput>;
export type ImagePrepareSendInput = z.infer<typeof ImagePrepareSendInput>;
export type ImageToolInput = z.infer<typeof ImageToolInput>;

export class ImageTool implements Tool<ImageToolInput> {
  readonly name = "image";
  readonly description =
    "Process and edit EXISTING images already saved in the workspace: resize, crop, rotate, " +
    "apply filters, convert format. This tool CANNOT generate new images from a text prompt/description " +
    "— there is no text-to-image model wired into it. If the user asks to \"create\"/\"generate\" an image " +
    "with no existing image to work from, say so directly instead of calling this tool.";

  constructor(private readonly security: SecurityPolicy) {}

  private safePath(path: string): string {
    return resolveSafePath(path, this.security.fsRoot);
  }

  async execute(input: ImageToolInput): Promise<ToolResult> {
    const start = performance.now();

    try {
      switch (input.action) {
        case "edit": {
          const inPath = this.safePath(input.inputPath);
          const outPath = this.safePath(input.outputPath);

          const res = await editImage(inPath, outPath, input.operations);
          const durationMs = performance.now() - start;

          return {
            success: res.success,
            output: res.message,
            error: res.success ? null : (res.error ?? res.message),
            exitCode: res.success ? 0 : 1,
            durationMs,
            filesChanged: res.success && res.outputPath ? [res.outputPath] : [],
            metadata: {
              operation: "edit",
              inputPath: inPath,
              outputPath: outPath,
              dimensions: res.dimensions,
              mimeType: res.mimeType,
              bytes: res.bytes,
            },
          };
        }
        case "prepare_send": {
          const inPath = this.safePath(input.inputPath);
          const payload = await prepareMediaPayload(inPath, input.channel, { caption: input.caption });
          const durationMs = performance.now() - start;

          return {
            success: true,
            output: JSON.stringify({
              tool: "image",
              action: "prepare_send",
              channel: input.channel,
              payload,
            }),
            error: null,
            exitCode: 0,
            durationMs,
            filesChanged: [],
            metadata: {
              operation: "prepare_send",
              channel: input.channel,
              filename: payload.filename,
              mimeType: "mimetype" in payload ? payload.mimetype : payload.mime_type,
              fileSize: payload.fileSize,
              dimensions: payload.dimensions,
            },
          };
        }
      }
    } catch (err) {
      return {
        success: false,
        output: null,
        error: err instanceof Error ? err.message : String(err),
        exitCode: 1,
        durationMs: performance.now() - start,
        filesChanged: [],
        metadata: { operation: input.action },
      };
    }
  }
}
