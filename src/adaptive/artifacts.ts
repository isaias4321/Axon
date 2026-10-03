/**
 * Rastreador de artefatos por sessão.
 *
 * Problema real que isto resolve: o Axon já sabia ler/extrair/gerar
 * arquivos, mas nunca registrava QUE arquivo pertence a QUAL sessão, nem
 * qual é "o atual" — então "o projeto atual"/"esse zip"/"como eu executo
 * isso" nunca resolviam a nada, e o agente perguntava de novo o que já
 * tinha acabado de processar minutos antes.
 *
 * A resolução de "artefato atual"/"projeto atual" é DETERMINÍSTICA (lida
 * do SQLite via sessionContextRepo), não deixada para o LLM adivinhar a
 * partir do texto do histórico — só o RESULTADO dessa resolução (um bloco
 * de texto estruturado) é que entra no prompt.
 */

import { basename, relative } from "node:path";
import { artifactsRepo, sessionContextRepo, type Artifact, type ArtifactType } from "../lib/db/sessionRepo.js";
import { getWorkspaceRoot } from "./tools/registry.js";

export interface RegisterArtifactInput {
  sessionId: string;
  name: string;
  type: ArtifactType;
  /** Caminho absoluto OU relativo ao workspace — normalizado internamente. */
  workspacePath: string;
  /**
   * Artefato de origem, se este foi derivado de outro (ex.: pasta extraída
   * a partir de um zip enviado). Aceita um id numérico direto OU o caminho
   * de workspace do artefato pai (resolvido via `findByWorkspacePath`).
   */
  parentArtifactPath?: string | null;
  parentArtifactId?: number | null;
  metadata?: Record<string, unknown> | null;
}

const PROJECT_TYPES: ArtifactType[] = ["extracted_dir", "generated_project"];

function toWorkspaceRelative(path: string): string {
  const workspace = getWorkspaceRoot();
  if (path.startsWith(workspace)) {
    const rel = relative(workspace, path);
    return rel || path;
  }
  return path;
}

/**
 * Registra um novo artefato para a sessão e atualiza `session_context`:
 * todo artefato novo vira o "artefato atual"; artefatos que representam um
 * PROJETO (pasta extraída ou projeto gerado) também viram o "projeto atual".
 */
export function registerArtifact(input: RegisterArtifactInput): Artifact {
  const workspacePath = toWorkspaceRelative(input.workspacePath);

  let parentId = input.parentArtifactId ?? null;
  if (parentId == null && input.parentArtifactPath) {
    const parent = artifactsRepo.findByWorkspacePath(input.sessionId, toWorkspaceRelative(input.parentArtifactPath));
    parentId = parent?.id ?? null;
  }

  const artifact = artifactsRepo.create({
    session_id: input.sessionId,
    name: input.name,
    type: input.type,
    workspace_path: workspacePath,
    parent_artifact_id: parentId,
    metadata: input.metadata ?? null,
  });

  const isProject = PROJECT_TYPES.includes(input.type);
  sessionContextRepo.set(input.sessionId, {
    current_artifact_id: artifact.id,
    current_project_id: isProject ? artifact.id : undefined,
  });

  return artifact;
}

export interface SessionArtifactContext {
  currentArtifact: Artifact | null;
  currentProject: Artifact | null;
  /** Artefato imediatamente anterior ao atual (mesma sessão), se houver. */
  previousArtifact: Artifact | null;
  recentArtifacts: Artifact[];
}

/**
 * Lê o contexto de artefatos da sessão — 100% determinístico, sem LLM.
 * Fail-open: se o SQLite não estiver pronto/migrado por qualquer motivo,
 * devolve um contexto vazio em vez de derrubar a tarefa inteira — isto é um
 * recurso de contexto, nunca deve ser um ponto de falha do caminho principal.
 */
export function getSessionArtifactContext(sessionId: string, recentLimit = 5): SessionArtifactContext {
  try {
    const ctx = sessionContextRepo.get(sessionId);
    const recentArtifacts = artifactsRepo.getBySession(sessionId, recentLimit);

    const currentArtifact = ctx?.current_artifact_id != null ? artifactsRepo.getById(ctx.current_artifact_id) : null;
    const currentProject = ctx?.current_project_id != null ? artifactsRepo.getById(ctx.current_project_id) : null;
    const previousArtifact = recentArtifacts.find((a) => a.id !== currentArtifact?.id) ?? null;

    return { currentArtifact, currentProject, previousArtifact, recentArtifacts };
  } catch {
    return { currentArtifact: null, currentProject: null, previousArtifact: null, recentArtifacts: [] };
  }
}

/**
 * Monta o bloco de texto determinístico injetado no prompt do LLM,
 * descrevendo o contexto de artefatos da sessão — o exemplo do pedido
 * original ("Current project / Current artifact / Previous artifact").
 * Retorna string vazia quando a sessão não tem nenhum artefato ainda.
 */
export function buildArtifactContextBlock(sessionId: string): string {
  try {
    const { currentArtifact, currentProject, previousArtifact } = getSessionArtifactContext(sessionId);
    if (!currentArtifact && !currentProject) return "";

    const lines: string[] = [
      'Contexto de artefatos desta sessão (use para resolver referências como "esse arquivo", "o projeto atual", "aquele zip" — NÃO peça ao usuário para reenviar algo que já está listado aqui):',
    ];

    if (currentProject) {
      lines.push(`- Projeto atual: "${currentProject.name}" (em ${currentProject.workspace_path})`);
    }
    if (currentArtifact && currentArtifact.id !== currentProject?.id) {
      lines.push(
        `- Artefato atual: "${currentArtifact.name}" (${describeType(currentArtifact.type)}, em ${currentArtifact.workspace_path})`
      );
    }
    if (previousArtifact && previousArtifact.id !== currentArtifact?.id && previousArtifact.id !== currentProject?.id) {
      lines.push(
        `- Artefato anterior: "${previousArtifact.name}" (${describeType(previousArtifact.type)}, em ${previousArtifact.workspace_path})`
      );
    }
    if (currentArtifact?.parent_artifact_id) {
      const parent = artifactsRepo.getById(currentArtifact.parent_artifact_id);
      if (parent) lines.push(`- "${currentArtifact.name}" foi gerado a partir de "${parent.name}".`);
    }

    return lines.join("\n");
  } catch {
    // Fail-open — ver comentário em getSessionArtifactContext.
    return "";
  }
}

function describeType(type: ArtifactType): string {
  switch (type) {
    case "uploaded_file":
    case "uploaded_zip":
      return "enviado pelo usuário";
    case "extracted_dir":
      return "extraído de um zip enviado";
    case "generated_file":
    case "generated_zip":
    case "generated_project":
      return "gerado pelo agente";
    default:
      return type;
  }
}

/**
 * Observa o resultado de UMA execução de tool (compression/document/project)
 * e registra automaticamente os artefatos que ela produziu, sem que cada
 * tool precise saber nada sobre sessão/persistência — as tools continuam
 * puras, isto só INSPECIONA a `metadata` que elas já devolviam. Chamado pelo
 * loop autônomo logo após cada observação bem-sucedida (ver autonomous.ts).
 * Nunca lança: registrar artefato é um recurso de contexto, não deve
 * derrubar a execução da tarefa real se algo aqui falhar.
 */
export function registerArtifactsFromObservation(
  sessionId: string,
  toolName: string,
  observation: { success: boolean; metadata: Record<string, unknown> }
): void {
  if (!sessionId || !observation.success) return;
  const meta = observation.metadata ?? {};
  const operation = typeof meta.operation === "string" ? meta.operation : null;
  const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

  try {
    if (toolName === "project" && operation === "scaffold") {
      const projectRoot = str(meta.projectRoot);
      const projectName = str(meta.projectName) ?? "projeto";
      const zipPath = str(meta.zipPath);

      let projectArtifactId: number | null = null;
      if (projectRoot) {
        const projectArtifact = registerArtifact({
          sessionId,
          name: projectName,
          type: "generated_project",
          workspacePath: projectRoot,
          metadata: { files: meta.files ?? [] },
        });
        projectArtifactId = projectArtifact.id;
      }
      if (zipPath) {
        registerArtifact({
          sessionId,
          name: basename(zipPath),
          type: "generated_zip",
          workspacePath: zipPath,
          parentArtifactId: projectArtifactId,
        });
      }
      return;
    }

    if (toolName === "compression") {
      if (operation === "extract") {
        const targetDir = str(meta.targetDir);
        const inputPath = str(meta.inputPath);
        if (targetDir) {
          registerArtifact({
            sessionId,
            name: basename(targetDir),
            type: "extracted_dir",
            workspacePath: targetDir,
            parentArtifactPath: inputPath,
          });
        }
        return;
      }
      if (operation === "zip" || operation === "rar") {
        const path = str(meta.path);
        if (path) {
          registerArtifact({ sessionId, name: basename(path), type: "generated_zip", workspacePath: path });
        }
      }
      // "list" não gera artefato novo — só leu um arquivo que já existia.
      return;
    }

    if (toolName === "document" && (operation === "zip" || operation === "pdf")) {
      const path = str(meta.path);
      if (path) {
        registerArtifact({
          sessionId,
          name: basename(path),
          type: operation === "zip" ? "generated_zip" : "generated_file",
          workspacePath: path,
        });
      }
    }
  } catch {
    // Ver comentário acima da função: nunca propaga.
  }
}
