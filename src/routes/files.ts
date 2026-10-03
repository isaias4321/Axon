/**
 * Rota de gerenciamento de arquivos: Upload (/v1/files/upload) e Download (/v1/files/download).
 */

import { existsSync, createReadStream, statSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative, basename } from "node:path";
import type { FastifyPluginAsync } from "fastify";
import { getWorkspaceRoot, resolveSafePath } from "../adaptive/tools/registry.js";
import { getGenericMimeType } from "../lib/mime.js";
import { registerArtifact } from "../adaptive/artifacts.js";

function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(0)}MB`;
}

export const filesRoute: FastifyPluginAsync = async (fastify) => {
  /**
   * POST /v1/files/upload
   * Recebe um arquivo via multipart/form-data e salva no diretório do workspace.
   */
  fastify.post("/v1/files/upload", async (request, reply) => {
    try {
      const data = await request.file();
      if (!data) {
        return reply.status(400).send({ error: "Nenhum arquivo enviado na requisição." });
      }

      const workspace = getWorkspaceRoot();
      const filename = basename(data.filename || "upload.bin");
      const safeFilePath = resolveSafePath(filename, workspace);

      const buffer = await data.toBuffer();
      const dir = join(safeFilePath, "..");
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      writeFileSync(safeFilePath, buffer);

      const stats = statSync(safeFilePath);
      const relativePath = relative(workspace, safeFilePath) || filename;

      // Registra o upload como artefato da sessão (ver src/adaptive/artifacts.js)
      // — sem isso, o agente nunca soube QUE arquivo foi enviado em QUAL
      // conversa, então "esse arquivo"/"o zip que mandei" nunca resolviam a
      // nada. `sessionId` vem de um campo do próprio multipart (o frontend
      // manda junto com o arquivo); upload sem sessionId ainda funciona
      // normalmente, só não fica associado a nenhuma sessão.
      const sessionIdField = data.fields?.sessionId;
      const sessionId =
        sessionIdField && !Array.isArray(sessionIdField) && "value" in sessionIdField
          ? String(sessionIdField.value)
          : null;
      if (sessionId) {
        try {
          registerArtifact({
            sessionId,
            name: filename,
            type: /\.(zip|rar|7z)$/i.test(filename) ? "uploaded_zip" : "uploaded_file",
            workspacePath: relativePath,
          });
        } catch {
          // Registro de artefato é um recurso de contexto — nunca deve
          // derrubar um upload que já foi salvo com sucesso em disco.
        }
      }

      return reply.status(200).send({
        success: true,
        filename,
        path: relativePath,
        size: stats.size,
        mimeType: getGenericMimeType(filename),
        downloadUrl: `/v1/files/download?path=${encodeURIComponent(relativePath)}`,
      });
    } catch (err) {
      // @fastify/multipart lança um erro com este código quando o arquivo
      // excede MAX_UPLOAD_SIZE_MB (ver src/app.ts) — tratado à parte para
      // dar uma mensagem clara em vez do texto genérico em inglês da lib.
      const code = (err as { code?: string })?.code;
      if (code === "FST_REQ_FILE_TOO_LARGE") {
        const limitMb = process.env.MAX_UPLOAD_SIZE_MB
          ? `${process.env.MAX_UPLOAD_SIZE_MB}MB`
          : formatMb(fastify.initialConfig.bodyLimit ?? 1024 * 1024);
        return reply.status(413).send({
          error: `Arquivo maior que o limite permitido (${limitMb}). Aumente MAX_UPLOAD_SIZE_MB no .env se precisar enviar arquivos maiores.`,
        });
      }

      return reply.status(500).send({
        error: `Falha no upload de arquivo: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });

  /**
   * GET /v1/files/download?path=...
   * Serve o arquivo para download/visualização com validação de segurança dentro do workspace.
   */
  fastify.get("/v1/files/download", async (request, reply) => {
    const query = request.query as { path?: string };
    if (!query.path || typeof query.path !== "string") {
      return reply.status(400).send({ error: "Parâmetro 'path' é obrigatório." });
    }

    try {
      const workspace = getWorkspaceRoot();
      const filePath = resolveSafePath(query.path, workspace);

      if (!existsSync(filePath)) {
        return reply.status(404).send({ error: `Arquivo não encontrado: ${query.path}` });
      }

      const stats = statSync(filePath);
      if (!stats.isFile()) {
        return reply.status(400).send({ error: `O caminho indicado não é um arquivo.` });
      }

      const mimeType = getGenericMimeType(filePath);
      const isInline = /^image\//.test(mimeType) || mimeType === "application/pdf";
      const disposition = isInline ? "inline" : `attachment; filename="${basename(filePath)}"`;

      reply
        .header("Content-Type", mimeType)
        .header("Content-Length", stats.size)
        .header("Content-Disposition", disposition);

      const stream = createReadStream(filePath);
      return reply.send(stream);
    } catch (err) {
      return reply.status(403).send({
        error: `Acesso negado ou erro ao ler arquivo: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });
};

export default filesRoute;
