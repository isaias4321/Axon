export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Decide se um erro específico deve disparar uma nova tentativa. */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
}

/**
 * Erro lançado por provedores para sinalizar respostas HTTP com status,
 * usado por `defaultShouldRetry` para decidir se vale a pena tentar de novo.
 */
export class ProviderHttpError extends Error {
  /** Status HTTP do provedor. */
  public readonly status: number;
  /** Se verdadeiro, o erro é transitório e deve disparar fallback/retries. */
  public readonly isTransient: boolean;
  /** Atraso solicitado pelo provedor via Retry-After, em milissegundos. */
  public readonly retryAfterMs?: number;

  constructor(
    message: string,
    status: number,
    isTransient?: boolean,
    retryAfterMs?: number
  ) {
    super(message);
    this.name = "ProviderHttpError";
    this.status = status;
    this.isTransient = isTransient ?? false;
    this.retryAfterMs = retryAfterMs;
  }
}

function defaultShouldRetry(error: unknown): boolean {
  if (error instanceof ProviderHttpError) {
    // 429 (rate limit) e 5xx (erro transitório do servidor) valem retry.
    // 4xx de cliente (ex: 400, 401) não adianta tentar de novo.
    return error.status === 429 || error.status >= 500;
  }
  // Erros de rede (timeout, conexão recusada) também valem retry.
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Executa `fn`, tentando novamente com backoff exponencial + jitter em
 * caso de falha, até `maxAttempts` tentativas.
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const {
    maxAttempts = 3,
    baseDelayMs = 300,
    maxDelayMs = 5_000,
    shouldRetry = defaultShouldRetry,
  } = options;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      const isLastAttempt = attempt === maxAttempts;
      // Última tentativa OU erro não-retryável: cancela o sleep e lança já.
      // Isso garante que, mesmo sendo retryable mas não isTransient, não haja
      // um sleep inútil no fim do loop — a exceção sobe imediatamente para o fallback.
      if (isLastAttempt || !shouldRetry(error, attempt)) {
        throw error;
      }

      // Determinar base do backoff
      let base: number;
      if (error instanceof ProviderHttpError) {
        if (error.isTransient) {
          // Erros transitivos (503, 502): backoff curto de 500ms
          base = 500;
        } else if (error.status === 429) {
          // Rate limit: backoff médio
          base = baseDelayMs * 3;
        } else {
          base = baseDelayMs;
        }
      } else {
        base = baseDelayMs;
      }

      const isRateLimit = error instanceof ProviderHttpError && error.status === 429;
      const exponential = Math.min(maxDelayMs, base * 2 ** (attempt - 1));
      const jitter = Math.random() * exponential * 0.3;

      // Se for rate limit e backoff curto, usar delay fixo de 2s para não sobrecarregar
      const providerDelay = error instanceof ProviderHttpError ? error.retryAfterMs : undefined;
      const delay = providerDelay !== undefined
        ? Math.max(providerDelay, Math.min(exponential + jitter, maxDelayMs))
        : isRateLimit && error.isTransient ? 2000 : Math.min(exponential + jitter, maxDelayMs);

      await sleep(delay);
    }
  }

  // Inalcançável na prática (o loop sempre retorna ou lança), mas satisfaz o TypeScript.
  throw lastError;
}
