/**
 * Fase 6+ — Caminho de execução dedicado para "monte um projeto e me
 * entregue (em zip)".
 *
 * Por que isto existe separado do loop autônomo padrão (`runAutonomous`):
 * esse loop funciona por PASSOS, cada um com uma descrição curta em texto
 * livre gerada por um LLM "planner", que depois é re-interpretada por
 * regex (`buildToolInput` em executor.ts) para virar os parâmetros de UMA
 * chamada de tool. Isso é robusto o bastante para ações simples ("leia o
 * arquivo X", "liste o conteúdo do zip Y"), mas estruturalmente inadequado
 * para "crie um projeto": não dá para extrair o CONTEÚDO de vários
 * arquivos de código reais a partir de uma frase curta como "Criar
 * arquivo index.js com o código do servidor" via regex.
 *
 * Este módulo faz UMA chamada dedicada ao LLM pedindo TODOS os arquivos de
 * uma vez, como um JSON estruturado (validado com o mesmo schema Zod da
 * ProjectTool), e então invoca a tool diretamente — sem depender de
 * nenhuma extração por regex.
 */

import type { ProviderAdapter } from "../providers/types.js";
import type { ChatCompletionRequest } from "../schemas/chat.js";
import { buildCandidateList, completeWithFallback, type FallbackCandidate } from "./providerFallback.js";
import type { ProgressEmitter } from "./progress.js";
import { ProjectScaffoldInput, sanitizeProjectName, type ProjectToolInput } from "./tools/projectTool.js";
import { createDefaultToolRegistry, getWorkspaceRoot, type ToolRegistry, type ToolRegistryOptions } from "./tools/registry.js";
import { registerArtifactsFromObservation } from "./artifacts.js";

export interface ProjectScaffoldOptions {
  runner?: { complete: ProviderAdapter["complete"] };
  onProgress?: ProgressEmitter;
  signal?: AbortSignal;
  toolRegistry?: ToolRegistry;
  toolSecurity?: ToolRegistryOptions["security"];
  /** Quando presente, registra o projeto/zip gerados como artefatos da sessão. */
  sessionId?: string;
}

export interface ProjectScaffoldReport {
  strategy: "project_scaffold";
  executed: boolean;
  content: string;
  error: string | null;
  projectName?: string;
  filesCreated?: string[];
  zipPath?: string | null;
}

const SYSTEM_PROMPT =
  "Você é um gerador de projetos de software. Responda SOMENTE com um objeto JSON válido — " +
  "nada de markdown, nada de crases, nenhum texto antes ou depois — no formato EXATO:\n" +
  '{"projectName": "nome-curto-em-kebab-case", "files": [{"path": "caminho/relativo.ext", "content": "conteúdo completo do arquivo"}]}\n\n' +
  "Regras:\n" +
  "- Crie um projeto PEQUENO mas genuinamente FUNCIONAL que atenda ao pedido do usuário.\n" +
  "- Inclua só os arquivos essenciais (normalmente entre 2 e 10 arquivos).\n" +
  "- Cada \"content\" deve ser o conteúdo REAL e completo do arquivo, pronto para uso — nunca um placeholder, " +
  "comentário \"TODO\" ou trecho incompleto.\n" +
  "- Não invente dependências externas que exijam instalação, a menos que o pedido peça isso explicitamente; " +
  "prefira soluções que rodem só com a linguagem padrão.\n" +
  "- Inclua um README.md curto explicando como rodar o projeto.\n" +
  "- \"path\" é sempre relativo à raiz do projeto (nunca comece com \"/\" nem use \"..\").";

/**
 * Tenta extrair um objeto JSON de uma resposta de LLM que deveria ser só
 * JSON, mas pode vir cercada de crases de markdown ou algum texto solto —
 * comportamento comum mesmo quando o system prompt pede JSON puro.
 */
function extractJsonObject(raw: string): unknown {
  const attempts: string[] = [raw.trim()];

  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch?.[1]) attempts.push(fenceMatch[1].trim());

  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    attempts.push(raw.slice(firstBrace, lastBrace + 1));
  }

  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt);
    } catch {
      // tenta a próxima variante
    }
  }
  return undefined;
}

/**
 * Monta a mensagem final entregue ao usuário: resumo do que foi criado, a
 * lista de arquivos (dentro de um bloco de código, para NÃO virar um botão de
 * download por arquivo no frontend) e, quando há zip, o caminho dele em texto
 * puro — é esse caminho que o frontend transforma no botão de download.
 */
function buildDeliveryMessage(toolOutput: string | null, files: string[], zipPath: string | null): string {
  const summary = toolOutput ?? "Projeto criado com sucesso.";
  if (files.length === 0) return summary;

  const tree = files.map((f) => `  ${f}`).join("\n");
  const zipLine = zipPath ? `\n\nPara baixar o projeto completo: ${zipPath}` : "";
  return `${summary}\n\nArquivos criados:\n\n\`\`\`\n${tree}\n\`\`\`${zipLine}`;
}

export async function runProjectScaffold(
  task: string,
  decision: {
    provider: string | null;
    model: string | null;
    rankedCandidates?: readonly FallbackCandidate[];
  },
  providers: Map<string, ProviderAdapter>,
  options: ProjectScaffoldOptions = {}
): Promise<ProjectScaffoldReport> {
  const { runner, onProgress, signal, toolRegistry, toolSecurity, sessionId } = options;

  if (!decision.provider || !decision.model) {
    return {
      strategy: "project_scaffold",
      executed: false,
      content: "Não há um modelo disponível no momento para gerar o projeto.",
      error: "no_model_available",
    };
  }

  onProgress?.({ phase: "execucao", detail: "Gerando os arquivos do projeto…" });

  let raw: string;
  try {
    const candidates = buildCandidateList(decision.provider, decision.model, decision.rankedCandidates ?? [], providers);
    const { response } = await completeWithFallback(
      (candidate) => ({
        provider: candidate.provider as ChatCompletionRequest["provider"],
        model: candidate.model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: task },
        ],
        temperature: 0.3,
        max_tokens: 4096,
        stream: false,
      }),
      providers,
      candidates,
      { runner, onProgress, signal }
    );
    raw = response.content ?? "";
  } catch (err) {
    return {
      strategy: "project_scaffold",
      executed: false,
      content: `Não consegui gerar o projeto: ${err instanceof Error ? err.message : String(err)}`,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const parsed = extractJsonObject(raw);
  if (parsed === undefined) {
    return {
      strategy: "project_scaffold",
      executed: false,
      content:
        "O modelo não retornou um JSON válido com os arquivos do projeto. Tente reformular o pedido " +
        "de forma mais específica (ex.: qual linguagem, o que o projeto deve fazer).",
      error: "invalid_json_response",
    };
  }

  const candidatePayload =
    parsed && typeof parsed === "object" && !("action" in (parsed as Record<string, unknown>))
      ? { action: "scaffold" as const, ...(parsed as Record<string, unknown>) }
      : parsed;

  const validated = ProjectScaffoldInput.safeParse(candidatePayload);
  if (!validated.success) {
    return {
      strategy: "project_scaffold",
      executed: false,
      content:
        "O modelo retornou um JSON com formato inesperado para o projeto " +
        `(${validated.error.issues.map((i) => i.message).join("; ")}). Tente novamente.`,
      error: "schema_validation_failed",
    };
  }

  onProgress?.({
    phase: "execucao",
    detail: `Criando ${validated.data.files.length} arquivo(s) do projeto "${sanitizeProjectName(validated.data.projectName)}"…`,
  });

  const registry: ToolRegistry =
    toolRegistry ??
    createDefaultToolRegistry({
      security: toolSecurity?.fsRoot ? toolSecurity : { ...(toolSecurity ?? {}), fsRoot: getWorkspaceRoot() },
    });

  const result = await registry.execute<ProjectToolInput>("project", validated.data);

  if (!result.success) {
    return {
      strategy: "project_scaffold",
      executed: false,
      content: `Falha ao criar o projeto: ${result.error ?? result.output ?? "motivo desconhecido"}`,
      error: result.error ?? "project_tool_failed",
    };
  }

  if (sessionId) {
    registerArtifactsFromObservation(sessionId, "project", result);
  }

  const zipPath = typeof result.metadata.zipPath === "string" ? result.metadata.zipPath : null;
  const files = Array.isArray(result.metadata.files) ? (result.metadata.files as string[]) : [];

  return {
    strategy: "project_scaffold",
    executed: true,
    content: buildDeliveryMessage(result.output, files, zipPath),
    error: null,
    projectName: typeof result.metadata.projectName === "string" ? result.metadata.projectName : undefined,
    filesCreated: files,
    zipPath,
  };
}
