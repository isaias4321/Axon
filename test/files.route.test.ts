import Fastify from "fastify";
import multipart from "@fastify/multipart";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, existsSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import authPlugin from "../src/plugins/auth.js";
import filesRoute from "../src/routes/files.js";
import { buildApp } from "../src/app.js";
import { loadEnv } from "../src/config.js";
import { createLogger } from "../src/lib/logger.js";
import { setDriverForTest, createInMemoryDriver } from "../src/lib/db/driver.js";
import { runMigrations } from "../src/lib/db/migrations.js";
import { getSessionArtifactContext } from "../src/adaptive/artifacts.js";

const VALID_KEY = "test-key";

let workspaceDir: string;
let previousWorkspaceEnv: string | undefined;

function buildTestApp() {
  const fastify = Fastify({ logger: false });
  fastify.register(multipart);
  fastify.register(authPlugin, { validKeys: [VALID_KEY] });
  fastify.register(filesRoute);
  return fastify;
}

function multipartBody(filename: string, content: Buffer | string, boundary = "----axonTestBoundary") {
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\n`),
    Buffer.from(`Content-Disposition: form-data; name="file"; filename="${filename}"\r\n`),
    Buffer.from("Content-Type: application/octet-stream\r\n\r\n"),
    Buffer.isBuffer(content) ? content : Buffer.from(content),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { body, boundary };
}

/** Igual a `multipartBody`, mas inclui um campo `sessionId` ANTES do arquivo
 *  (mesma ordem que o frontend usa) — para testar o registro de artefato. */
function multipartBodyWithSession(
  filename: string,
  content: Buffer | string,
  sessionId: string,
  boundary = "----axonTestBoundarySession"
) {
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\n`),
    Buffer.from(`Content-Disposition: form-data; name="sessionId"\r\n\r\n${sessionId}\r\n`),
    Buffer.from(`--${boundary}\r\n`),
    Buffer.from(`Content-Disposition: form-data; name="file"; filename="${filename}"\r\n`),
    Buffer.from("Content-Type: application/octet-stream\r\n\r\n"),
    Buffer.isBuffer(content) ? content : Buffer.from(content),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { body, boundary };
}

beforeAll(() => {
  // Isola cada execução de teste do workspace real do repositório.
  workspaceDir = mkdtempSync(join(tmpdir(), "axon-files-test-"));
  previousWorkspaceEnv = process.env.AXON_WORKSPACE;
  process.env.AXON_WORKSPACE = workspaceDir;
});

afterAll(() => {
  if (previousWorkspaceEnv === undefined) {
    delete process.env.AXON_WORKSPACE;
  } else {
    process.env.AXON_WORKSPACE = previousWorkspaceEnv;
  }
  rmSync(workspaceDir, { recursive: true, force: true });
});

beforeEach(() => {
  // Isola o SQLite real (artefatos) por teste — vários testes de upload
  // agora registram artefato quando `sessionId` é enviado.
  setDriverForTest(createInMemoryDriver());
  runMigrations();
});

afterEach(() => {
  // Limpa arquivos criados no workspace entre testes, preservando o diretório.
  for (const entry of readdirSync(workspaceDir)) {
    rmSync(join(workspaceDir, entry), { recursive: true, force: true });
  }
});

describe("POST /v1/files/upload", () => {
  it("rejeita upload sem x-api-key (401)", async () => {
    const fastify = buildTestApp();
    const { body, boundary } = multipartBody("teste.txt", "conteudo");

    const response = await fastify.inject({
      method: "POST",
      url: "/v1/files/upload",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });

    expect(response.statusCode).toBe(401);
  });

  it("salva o arquivo no workspace e retorna metadados + downloadUrl", async () => {
    const fastify = buildTestApp();
    const { body, boundary } = multipartBody("relatorio.pdf", "%PDF-1.4 conteudo fake");

    const response = await fastify.inject({
      method: "POST",
      url: "/v1/files/upload",
      headers: {
        "content-type": `multipart/form-data; boundary=${boundary}`,
        "x-api-key": VALID_KEY,
      },
      payload: body,
    });

    expect(response.statusCode).toBe(200);
    const data = response.json<{
      success: boolean;
      filename: string;
      path: string;
      size: number;
      downloadUrl: string;
    }>();

    expect(data.success).toBe(true);
    expect(data.filename).toBe("relatorio.pdf");
    expect(data.size).toBeGreaterThan(0);
    expect(data.downloadUrl).toContain("/v1/files/download?path=");
    expect(existsSync(join(workspaceDir, "relatorio.pdf"))).toBe(true);
  });

  it("retorna 400 quando nenhum arquivo é enviado", async () => {
    const fastify = buildTestApp();

    const response = await fastify.inject({
      method: "POST",
      url: "/v1/files/upload",
      headers: {
        "content-type": "multipart/form-data; boundary=----empty",
        "x-api-key": VALID_KEY,
      },
      payload: Buffer.from("------empty--\r\n"),
    });

    expect(response.statusCode).toBe(400);
  });

  it("usa apenas o basename do filename enviado (evita path traversal no upload)", async () => {
    const fastify = buildTestApp();
    const { body, boundary } = multipartBody("../../evil.txt", "conteudo malicioso");

    const response = await fastify.inject({
      method: "POST",
      url: "/v1/files/upload",
      headers: {
        "content-type": `multipart/form-data; boundary=${boundary}`,
        "x-api-key": VALID_KEY,
      },
      payload: body,
    });

    expect(response.statusCode).toBe(200);
    const data = response.json<{ path: string; filename: string }>();
    expect(data.filename).toBe("evil.txt");
    // O arquivo deve terminar DENTRO do workspace, nunca fora dele.
    expect(existsSync(join(workspaceDir, "evil.txt"))).toBe(true);
  });

  it("aceita arquivo maior que 1MB (limite antigo do Fastify) — regressão do bug do win.rar via app real", async () => {
    // Usa buildApp() de verdade (não o harness mínimo acima) para validar a
    // configuração de bodyLimit/multipart.limits.fileSize feita em
    // src/app.ts a partir de MAX_UPLOAD_SIZE_MB — é exatamente essa fiação
    // que faltava e causava 413 em uploads de .rar/.zip reais (>1MB).
    const env = loadEnv({
      ...process.env,
      AXON_WORKSPACE: workspaceDir,
      GATEWAY_API_KEYS: VALID_KEY,
      MAX_UPLOAD_SIZE_MB: "10",
    });
    const app = await buildApp(env, createLogger(env));
    await app.ready();

    try {
      // ~3MB, simulando um .rar/.zip real.
      const bigContent = Buffer.alloc(3 * 1024 * 1024, "a");
      const { body, boundary } = multipartBody("win.rar", bigContent);

      const response = await app.inject({
        method: "POST",
        url: "/v1/files/upload",
        headers: {
          "content-type": `multipart/form-data; boundary=${boundary}`,
          "x-api-key": VALID_KEY,
        },
        payload: body,
      });

      expect(response.statusCode).toBe(200);
      const data = response.json<{ success: boolean; size: number }>();
      expect(data.success).toBe(true);
      expect(data.size).toBe(bigContent.length);
    } finally {
      await app.close();
    }
  });

  it("retorna 413 com mensagem clara quando o arquivo excede MAX_UPLOAD_SIZE_MB", async () => {
    // App de teste isolado com um limite bem baixo, só para exercitar o
    // caminho de erro sem precisar upar dezenas de MB de verdade.
    const fastify = Fastify({ logger: false, bodyLimit: 1024 });
    fastify.register(multipart, { limits: { fileSize: 1024 } });
    fastify.register(authPlugin, { validKeys: [VALID_KEY] });
    fastify.register(filesRoute);

    const { body, boundary } = multipartBody("grande.zip", Buffer.alloc(5000, "b"));

    const response = await fastify.inject({
      method: "POST",
      url: "/v1/files/upload",
      headers: {
        "content-type": `multipart/form-data; boundary=${boundary}`,
        "x-api-key": VALID_KEY,
      },
      payload: body,
    });

    expect(response.statusCode).toBe(413);
    expect(response.json<{ error: string }>().error).toMatch(/limite/i);
  });

  it("registra o upload como artefato da sessão quando 'sessionId' é enviado no multipart", async () => {
    const fastify = buildTestApp();
    const { body, boundary } = multipartBodyWithSession("meu-projeto.zip", "PK-fake-zip-bytes", "sessao-upload-teste");

    const response = await fastify.inject({
      method: "POST",
      url: "/v1/files/upload",
      headers: {
        "content-type": `multipart/form-data; boundary=${boundary}`,
        "x-api-key": VALID_KEY,
      },
      payload: body,
    });

    expect(response.statusCode).toBe(200);
    const ctx = getSessionArtifactContext("sessao-upload-teste");
    expect(ctx.currentArtifact?.name).toBe("meu-projeto.zip");
    expect(ctx.currentArtifact?.type).toBe("uploaded_zip");
  });

  it("upload SEM 'sessionId' continua funcionando normalmente (só não vira artefato de sessão)", async () => {
    const fastify = buildTestApp();
    const { body, boundary } = multipartBody("solto.txt", "conteudo");

    const response = await fastify.inject({
      method: "POST",
      url: "/v1/files/upload",
      headers: {
        "content-type": `multipart/form-data; boundary=${boundary}`,
        "x-api-key": VALID_KEY,
      },
      payload: body,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ success: boolean }>().success).toBe(true);
  });
});

describe("GET /v1/files/download", () => {
  it("funciona SEM x-api-key (link/<a>/<img> não conseguem enviar headers customizados)", async () => {
    writeFileSync(join(workspaceDir, "publico.txt"), "conteudo publico");
    const fastify = buildTestApp();

    const response = await fastify.inject({
      method: "GET",
      url: "/v1/files/download?path=publico.txt",
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("conteudo publico");
  });

  it("retorna 404 para arquivo inexistente", async () => {
    const fastify = buildTestApp();

    const response = await fastify.inject({
      method: "GET",
      url: "/v1/files/download?path=nao-existe.zip",
    });

    expect(response.statusCode).toBe(404);
  });

  it("retorna 400 quando o parâmetro path não é enviado", async () => {
    const fastify = buildTestApp();

    const response = await fastify.inject({
      method: "GET",
      url: "/v1/files/download",
    });

    expect(response.statusCode).toBe(400);
  });

  it("bloqueia tentativa de path traversal para fora do workspace", async () => {
    const fastify = buildTestApp();

    const response = await fastify.inject({
      method: "GET",
      url: `/v1/files/download?path=${encodeURIComponent("../../../etc/passwd")}`,
    });

    expect([400, 403, 404]).toContain(response.statusCode);
  });

  it("define Content-Disposition attachment para arquivos não-inline (ex.: .rar/.zip)", async () => {
    mkdirSync(join(workspaceDir, "sub"), { recursive: true });
    writeFileSync(join(workspaceDir, "sub", "dados.zip"), "PK-fake-zip-bytes");
    const fastify = buildTestApp();

    const response = await fastify.inject({
      method: "GET",
      url: `/v1/files/download?path=${encodeURIComponent("sub/dados.zip")}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-disposition"]).toContain("attachment");
    expect(response.headers["content-disposition"]).toContain("dados.zip");
  });

  it("aceita caminho ABSOLUTO dentro do workspace (formato que o ProjectTool devolve e o frontend linka)", async () => {
    writeFileSync(join(workspaceDir, "projeto.zip"), "PK-fake-zip-bytes");
    const fastify = buildTestApp();

    const absolute = join(workspaceDir, "projeto.zip");
    const response = await fastify.inject({
      method: "GET",
      url: `/v1/files/download?path=${encodeURIComponent(absolute)}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-disposition"]).toContain("projeto.zip");
  });

  it("recusa caminho ABSOLUTO fora do workspace", async () => {
    const fastify = buildTestApp();
    const response = await fastify.inject({
      method: "GET",
      url: `/v1/files/download?path=${encodeURIComponent("/etc/passwd")}`,
    });
    expect([400, 403, 404]).toContain(response.statusCode);
  });

  it("round-trip: upload seguido de download retorna o mesmo conteúdo", async () => {
    const fastify = buildTestApp();
    const original = "conteudo-do-arquivo-de-teste-12345";
    const { body, boundary } = multipartBody("roundtrip.txt", original);

    const uploadRes = await fastify.inject({
      method: "POST",
      url: "/v1/files/upload",
      headers: {
        "content-type": `multipart/form-data; boundary=${boundary}`,
        "x-api-key": VALID_KEY,
      },
      payload: body,
    });
    const uploadData = uploadRes.json<{ downloadUrl: string }>();

    const downloadRes = await fastify.inject({
      method: "GET",
      url: uploadData.downloadUrl,
    });

    expect(downloadRes.statusCode).toBe(200);
    expect(downloadRes.body).toBe(original);
  });
});
