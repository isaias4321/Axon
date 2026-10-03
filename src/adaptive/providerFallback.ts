import type { ChatCompletionRequest, ChatCompletionResponse } from "../schemas/chat.js";
import type { ProviderAdapter } from "../providers/types.js";
import { ProviderHttpError } from "../lib/retry.js";
import type { ProgressEmitter } from "./progress.js";

/**
 * Fallback real entre providers/modelos quando o candidato primário falha
 * com um erro RECUPERÁVEL — 503/UNAVAILABLE, 502/BAD_GATEWAY,
 * 429/RATE_LIMIT, 404/model_not_found (catálogo desatualizado). Erros de
 * configuração (401, 400) NÃO disparam fallback: tentar outro provider às
 * cegas só mascararia um problema real de config.
 *
 * Extraído para um módulo único porque a chamada efetiva ao LLM acontece
 * em 4 lugares diferentes do runtime (execução direta, e as 3 peças do
 * loop autônomo: planner, executor, validator) — sem isso, corrigir o
 * fallback em um lugar e esquecer os outros 3 é fácil (foi exatamente o
 * que aconteceu: o fallback só cobria a execução direta, deixando o loop
 * autônomo — o modo mais usado para tarefas complexas — sem nenhuma
 * proteção).
 */

export interface FallbackCandidate {
  provider: string;
  model: string;
}

interface RunnerLike {
  complete(
    request: ChatCompletionRequest,
    signal?: AbortSignal,
    timeoutMs?: number
  ): Promise<ChatCompletionResponse>;
}

export interface CompleteWithFallbackOptions {
  /** Runner injetável (testes) — quando ausente, usa `providers.get(candidate.provider)`. */
  runner?: RunnerLike;
  signal?: AbortSignal;
  onProgress?: ProgressEmitter;
}

export interface CompleteWithFallbackResult {
  response: ChatCompletionResponse;
  /** Provider/modelo que de fato respondeu — pode diferir do candidato[0]
   * quando houve fallback. Quem chama deve usar isso para atualizar seus
   * próprios registros de decisão/custo, não o candidato original. */
  usedProvider: string;
  usedModel: string;
}

/**
 * Monta a lista de candidatos a tentar: o primário, seguido pelo ranking
 * do F2 (já ordenado por adequação/custo/latência), filtrando duplicatas
 * e providers não configurados.
 */
export function buildCandidateList(
  primaryProvider: string,
  primaryModel: string,
  rankedCandidates: readonly FallbackCandidate[],
  providers: Map<string, ProviderAdapter>
): FallbackCandidate[] {
  return [
    { provider: primaryProvider, model: primaryModel },
    ...rankedCandidates
      .filter((c) => !(c.provider === primaryProvider && c.model === primaryModel))
      .filter((c) => providers.has(c.provider))
      .map((c) => ({ provider: c.provider, model: c.model })),
  ];
}

function requireAdapter(providers: Map<string, ProviderAdapter>, provider: string): ProviderAdapter {
  const adapter = providers.get(provider);
  if (!adapter) {
    throw new Error(`Provedor '${provider}' não configurado para executar a tarefa.`);
  }
  return adapter;
}

export async function completeWithFallback(
  buildRequest: (candidate: FallbackCandidate) => ChatCompletionRequest,
  providers: Map<string, ProviderAdapter>,
  candidates: readonly FallbackCandidate[],
  options: CompleteWithFallbackOptions = {}
): Promise<CompleteWithFallbackResult> {
  if (candidates.length === 0) {
    throw new Error("Nenhum candidato de modelo disponível para executar a chamada.");
  }

  let lastError: unknown;

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i]!;
    const request = buildRequest(candidate);

    try {
      const response = options.runner
        ? await options.runner.complete(request, options.signal)
        : await requireAdapter(providers, candidate.provider).complete(request, options.signal);

      if (!response.content || response.content.trim().length === 0) {
        throw new ProviderHttpError(
          `${candidate.provider} retornou uma resposta sem conteúdo textual`,
          502,
          false
        );
      }

      if (i > 0) {
        options.onProgress?.({
          phase: "fallback",
          detail: `${candidates[0]!.provider}/${candidates[0]!.model} indisponível — usando ${candidate.provider}/${candidate.model} como alternativa`,
        });
      }

      return { response, usedProvider: candidate.provider, usedModel: candidate.model };
    } catch (error) {
      lastError = error;
      // "tool_use_failed" é uma peculiaridade conhecida de alguns modelos
      // "reasoning"/open-weight (ex.: openai/gpt-oss-120b na Groq): o
      // modelo tenta invocar uma ferramenta interna própria dele (ex.:
      // "container.exec") mesmo quando NADA na nossa requisição pede/
      // permite tool use — não é um erro de configuração nosso, é uma
      // falha específica desse modelo, não-determinística (o mesmo prompt
      // pode ou não disparar isso de novo). Um 400 genérico continua NÃO
      // recuperável (normalmente é bug do chamador, mascarar isso com
      // fallback só esconderia o problema real).
      const isDeterministicToolCallError =
        error instanceof ProviderHttpError &&
        error.status === 400 &&
        (error.message.includes("tool_use_failed") || error.message.includes("Tool choice is none"));
      const isRecoverable =
        error instanceof ProviderHttpError &&
        (error.isTransient || error.status === 429 || error.status === 404) &&
        !isDeterministicToolCallError;
      const isEmptyResponseError =
        error instanceof ProviderHttpError &&
        error.status === 502 &&
        error.message.includes("resposta sem conteúdo textual");
      const alternateProviderIndex = isDeterministicToolCallError
        ? candidates.findIndex((candidate, index) => index > i && candidate.provider !== candidates[i]!.provider)
        : isEmptyResponseError
          ? candidates.findIndex((candidate, index) => index > i && candidate.provider !== candidates[i]!.provider)
        : -1;
      const hasAlternateProvider = isDeterministicToolCallError || isEmptyResponseError;
      const hasMoreCandidates = hasAlternateProvider
        ? alternateProviderIndex >= 0
        : i < candidates.length - 1;

      if (isRecoverable && hasMoreCandidates) {
        options.onProgress?.({
          phase: "fallback",
          detail: `${candidate.provider}/${candidate.model} indisponível (${error.status}) — tentando próximo modelo…`,
        });
        continue;
      }

      if (hasAlternateProvider && alternateProviderIndex >= 0) {
        options.onProgress?.({
          phase: "fallback",
          detail: `${candidate.provider}/${candidate.model} retornou resposta incompatível — usando ${candidates[alternateProviderIndex]!.provider}/${candidates[alternateProviderIndex]!.model}`,
        });
        // O for incrementará para o candidato alternativo; candidatos do
        // mesmo provedor são deliberadamente pulados para não repetir o erro.
        i = alternateProviderIndex - 1;
        continue;
      }

      throw error;
    }
  }

  // Inalcançável na prática (loop sempre retorna ou lança) — satisfaz o TypeScript.
  throw lastError;
}
