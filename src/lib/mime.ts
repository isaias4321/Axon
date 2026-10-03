/**
 * Resolução de Content-Type para a rota genérica de upload/download de
 * arquivos (`src/routes/files.ts`).
 *
 * Existe separada de `getMimeTypeForFile` (`lib/imageProcessor.ts`) de
 * propósito: aquela função foi escrita para `prepareMediaPayload`, que SÓ
 * lida com imagens enviadas a WhatsApp/Telegram — por isso seu `default`
 * retorna `image/jpeg` (uma imagem sem extensão reconhecida ainda É uma
 * imagem nesse contexto). Reutilizá-la aqui faria QUALQUER arquivo sem
 * extensão de imagem reconhecida (.zip, .rar, .pdf, .docx, .txt...) ser
 * servido como `image/jpeg`, o que quebra o download (o navegador tenta
 * tratá-lo como imagem) e a lógica de "abrir inline vs. baixar" da rota.
 */

import { extname } from "node:path";

const MIME_BY_EXT: Record<string, string> = {
  // Documentos
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".csv": "text/csv",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".xml": "application/xml",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".ts": "application/typescript",
  ".log": "text/plain",
  ".sql": "application/sql",

  // Compactados
  ".zip": "application/zip",
  ".rar": "application/vnd.rar",
  ".7z": "application/x-7z-compressed",
  ".tar": "application/x-tar",
  ".gz": "application/gzip",
  ".tgz": "application/gzip",

  // Imagens
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",

  // Áudio/vídeo
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
};

/**
 * Resolve o Content-Type de um caminho de arquivo genérico. Extensão
 * desconhecida cai em `application/octet-stream` — o navegador oferece o
 * download em vez de tentar (mal) renderizar o conteúdo como outro tipo.
 */
export function getGenericMimeType(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}
