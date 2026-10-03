import { beforeEach, describe, expect, it } from "vitest";

import { setDriverForTest, createInMemoryDriver } from "../src/lib/db/driver.js";
import { runMigrations } from "../src/lib/db/migrations.js";
import { messagesRepo, artifactsRepo } from "../src/lib/db/sessionRepo.js";
import { SqliteSessionStore } from "../src/adaptive/memory.js";
import {
  registerArtifact,
  getSessionArtifactContext,
  buildArtifactContextBlock,
  registerArtifactsFromObservation,
} from "../src/adaptive/artifacts.js";

/**
 * Cobre o problema real relatado: "o Axon analisa um zip corretamente, mas
 * na mensagem seguinte ('tem como melhorar o projeto atual?') pergunta qual
 * projeto está sendo mencionado" — e o mesmo depois de gerar um zip novo
 * ("como faço pra executar?"). A causa raiz tinha DOIS componentes:
 * 1) `sessionStore` nunca era instanciado/injetado na rota /v1/run (ver
 *    src/app.ts) — a memória de turnos nunca rodava de verdade;
 * 2) não existia NENHUM registro de qual arquivo pertence a qual sessão,
 *    então não havia como resolver "o projeto atual" de forma alguma.
 */
beforeEach(() => {
  setDriverForTest(createInMemoryDriver());
  runMigrations();
});

describe("sessionRepo — messages", () => {
  it("grava e recupera mensagens em ordem cronológica", () => {
    messagesRepo.create({ session_id: "s1", role: "user", content: "oi" });
    messagesRepo.create({ session_id: "s1", role: "assistant", content: "olá!" });
    messagesRepo.create({ session_id: "s2", role: "user", content: "mensagem de outra sessão" });

    const recent = messagesRepo.getRecentBySession("s1", 10);
    expect(recent.map((m) => m.content)).toEqual(["oi", "olá!"]);
  });

  it("respeita o limite e mantém as mais recentes", () => {
    for (let i = 0; i < 5; i++) {
      messagesRepo.create({ session_id: "s1", role: "user", content: `msg-${i}` });
    }
    const recent = messagesRepo.getRecentBySession("s1", 2);
    expect(recent.map((m) => m.content)).toEqual(["msg-3", "msg-4"]);
  });

  it("deleteBySession remove só a sessão indicada", () => {
    messagesRepo.create({ session_id: "s1", role: "user", content: "a" });
    messagesRepo.create({ session_id: "s2", role: "user", content: "b" });
    messagesRepo.deleteBySession("s1");
    expect(messagesRepo.getRecentBySession("s1", 10)).toHaveLength(0);
    expect(messagesRepo.getRecentBySession("s2", 10)).toHaveLength(1);
  });
});

describe("SqliteSessionStore — substituto persistente do InMemorySessionStore", () => {
  it("implementa a mesma interface (remember/recall) persistindo no SQLite", () => {
    const store = new SqliteSessionStore();
    store.remember("sessao-x", { role: "user", content: "primeira mensagem" });
    store.remember("sessao-x", { role: "assistant", content: "resposta" });

    expect(store.recall("sessao-x")).toEqual([
      { role: "user", content: "primeira mensagem" },
      { role: "assistant", content: "resposta" },
    ]);
  });

  it("sobrevive à criação de uma NOVA instância (simula restart do processo)", () => {
    new SqliteSessionStore().remember("sessao-y", { role: "user", content: "antes do restart" });
    // Uma nova instância, como aconteceria após reiniciar o processo —
    // os dados continuam lá porque estão no SQLite, não em RAM.
    const afterRestart = new SqliteSessionStore();
    expect(afterRestart.recall("sessao-y")).toEqual([{ role: "user", content: "antes do restart" }]);
  });

  it("clearSession limpa só a sessão indicada", () => {
    const store = new SqliteSessionStore();
    store.remember("s1", { role: "user", content: "a" });
    store.remember("s2", { role: "user", content: "b" });
    store.clearSession("s1");
    expect(store.recall("s1")).toHaveLength(0);
    expect(store.recall("s2")).toHaveLength(1);
  });
});

describe("artifacts — registro e resolução determinística de 'atual'", () => {
  it("registrar um upload de zip o torna o artefato atual (mas não o projeto atual)", () => {
    const artifact = registerArtifact({
      sessionId: "s1",
      name: "axon-corrigido6.zip",
      type: "uploaded_zip",
      workspacePath: "axon-corrigido6.zip",
    });

    const ctx = getSessionArtifactContext("s1");
    expect(ctx.currentArtifact?.id).toBe(artifact.id);
    expect(ctx.currentProject).toBeNull(); // zip sozinho não é "o projeto" ainda
  });

  it("extrair o zip torna a pasta extraída o PROJETO atual, ligada ao zip de origem", () => {
    registerArtifact({ sessionId: "s1", name: "axon-corrigido6.zip", type: "uploaded_zip", workspacePath: "axon-corrigido6.zip" });
    const extracted = registerArtifact({
      sessionId: "s1",
      name: "axon-corrigido6_extracted",
      type: "extracted_dir",
      workspacePath: "axon-corrigido6_extracted",
      parentArtifactPath: "axon-corrigido6.zip",
    });

    const ctx = getSessionArtifactContext("s1");
    expect(ctx.currentProject?.id).toBe(extracted.id);
    expect(ctx.currentArtifact?.id).toBe(extracted.id);
    expect(extracted.parent_artifact_id).not.toBeNull();
  });

  it("gerar um zip novo o torna o artefato atual, mantendo rastro do anterior", () => {
    registerArtifact({ sessionId: "s1", name: "axon-corrigido6.zip", type: "uploaded_zip", workspacePath: "axon-corrigido6.zip" });
    const novo = registerArtifact({
      sessionId: "s1",
      name: "axon-corrigido7.zip",
      type: "generated_zip",
      workspacePath: "axon-corrigido7.zip",
      parentArtifactPath: "axon-corrigido6.zip",
    });

    const ctx = getSessionArtifactContext("s1");
    expect(ctx.currentArtifact?.id).toBe(novo.id);
    expect(ctx.previousArtifact?.name).toBe("axon-corrigido6.zip");
  });

  it("sessões diferentes não vazam contexto uma pra outra", () => {
    registerArtifact({ sessionId: "s1", name: "a.zip", type: "uploaded_zip", workspacePath: "a.zip" });
    const ctxOutraSessao = getSessionArtifactContext("s2");
    expect(ctxOutraSessao.currentArtifact).toBeNull();
  });

  describe("buildArtifactContextBlock", () => {
    it("retorna vazio quando a sessão não tem nenhum artefato", () => {
      expect(buildArtifactContextBlock("sessao-vazia")).toBe("");
    });

    it("menciona o nome do projeto/artefato atual em texto, para o LLM resolver referências", () => {
      registerArtifact({ sessionId: "s1", name: "axon-corrigido6.zip", type: "uploaded_zip", workspacePath: "axon-corrigido6.zip" });
      registerArtifact({
        sessionId: "s1",
        name: "axon-corrigido6_extracted",
        type: "extracted_dir",
        workspacePath: "axon-corrigido6_extracted",
        parentArtifactPath: "axon-corrigido6.zip",
      });

      const block = buildArtifactContextBlock("s1");
      expect(block).toContain("axon-corrigido6_extracted");
      expect(block).toContain("Projeto atual");
    });
  });

  describe("registerArtifactsFromObservation — ponte tool → artefato", () => {
    it("ProjectTool bem-sucedida registra o projeto E o zip, ligados", () => {
      registerArtifactsFromObservation("s1", "project", {
        success: true,
        metadata: {
          operation: "scaffold",
          projectName: "simple-flask-web",
          projectRoot: "simple-flask-web",
          files: ["simple-flask-web/app.py"],
          zipPath: "/app/simple-flask-web.zip",
        },
      });

      const ctx = getSessionArtifactContext("s1");
      expect(ctx.currentArtifact?.name).toBe("simple-flask-web.zip");
      expect(ctx.currentArtifact?.type).toBe("generated_zip");
      const project = artifactsRepo.getById(ctx.currentArtifact!.parent_artifact_id!);
      expect(project?.name).toBe("simple-flask-web");
      expect(project?.type).toBe("generated_project");
    });

    it("extração via CompressionTool liga a pasta extraída ao zip de origem já registrado", () => {
      registerArtifact({ sessionId: "s1", name: "x.zip", type: "uploaded_zip", workspacePath: "x.zip" });
      registerArtifactsFromObservation("s1", "compression", {
        success: true,
        metadata: { operation: "extract", inputPath: "x.zip", targetDir: "x_extracted", format: "zip", entries: ["a.txt"] },
      });

      const ctx = getSessionArtifactContext("s1");
      expect(ctx.currentProject?.workspace_path).toBe("x_extracted");
      const parent = artifactsRepo.getById(ctx.currentProject!.parent_artifact_id!);
      expect(parent?.name).toBe("x.zip");
    });

    it("tool malsucedida NÃO registra artefato nenhum", () => {
      registerArtifactsFromObservation("s1", "compression", {
        success: false,
        metadata: { operation: "extract", inputPath: "x.zip", targetDir: "x_extracted" },
      });
      expect(getSessionArtifactContext("s1").currentArtifact).toBeNull();
    });

    it("ação 'list' (só leitura) não gera nenhum artefato novo", () => {
      registerArtifactsFromObservation("s1", "compression", {
        success: true,
        metadata: { operation: "list", path: "x.zip", entries: ["a.txt"] },
      });
      expect(getSessionArtifactContext("s1").currentArtifact).toBeNull();
    });

    it("nunca lança mesmo com metadata ausente/malformada", () => {
      expect(() => registerArtifactsFromObservation("s1", "compression", { success: true, metadata: {} })).not.toThrow();
      expect(() => registerArtifactsFromObservation("s1", "project", { success: true, metadata: { operation: "scaffold" } })).not.toThrow();
    });
  });
});
