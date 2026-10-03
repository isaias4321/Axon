/**
 * Callback de progresso opcional, usado pelo runtime/autonomous/orchestrator
 * para reportar em tempo real o que está acontecendo durante a execução de
 * uma tarefa — consumido pela rota /v1/run em modo streaming (SSE) para
 * mostrar ao usuário passos reais ("analisando", "iteração 2/5: validando",
 * etc.) em vez de um indicador de "carregando" genérico.
 *
 * É deliberadamente "fire and forget": nunca deve lançar, nunca deve
 * bloquear a execução real da tarefa. Todo call-site trata a ausência do
 * callback (`onProgress?.(...)`) como padrão — reportar progresso é
 * inteiramente opcional e não deve mudar nenhum comportamento quando
 * omitido (compatibilidade total com quem já chama executeTask/
 * runAutonomous/runOrchestrated sem esse campo).
 */
export interface ProgressEvent {
  /** Identificador curto e estável da fase (ex.: "analise", "iteracao", "validacao"). */
  phase: string;
  /** Texto curto e legível para exibir ao usuário. */
  detail: string;
  /** Presente em fases iterativas (loop autônomo). */
  iteration?: number;
  maxIterations?: number;
  /**
   * Presente na fase "validacao" — sinal explícito de sucesso/falha, para
   * a interface não precisar adivinhar isso fazendo busca de palavras
   * (ex.: "não"/"falh") dentro de `detail`. Isso é frágil por natureza:
   * a DESCRIÇÃO da etapa sendo validada pode legitimamente conter a
   * palavra "não" (ex.: "...funções que ainda não possuem documentação"),
   * fazendo uma validação bem-sucedida ser exibida como reprovada.
   */
  passed?: boolean;
  /** Presente quando uma tool(arquivo/shell/http) de fato executou — permite
   *  a interface renderizar um cartão de execução estruturado (nome da tool,
   *  ação, status, duração, resumo, erro), sem expor conteúdo sensível. */
  tool?: {
    name: string;
    action: string;
    status: "ok" | "error";
    durationMs: number;
    summary?: string;
    error?: string;
  };
}

export type ProgressEmitter = (event: ProgressEvent) => void;
