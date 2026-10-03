/**
 * Fase 2 — Health-check de provedores.
 *
 * A disponibilidade no Fase 1 era só "o provider tem chave no registry".
 * Aqui, `filterHealthyProviders` adiciona uma verificação de runtime leve
 * (`GET /models` do adapter) e descarta provedores fora do ar / com chave
 * rejeitada ANTES do scoring do Model Router.
 *
 * O pipeline de decisão (`routeModel`/`rankCandidates`) continua PURO, sem
 * IO: quem faz rede é a camada de health-check, injetada na rota. Com
 * `HEALTH_CHECK_ENABLED=false` (default), `healthChecker` não é injetado e
 * nada disto roda — os testes seguem 100% offline.
 *
 * Resultados são cacheados por `ttlMs` para `/v1/decide` não bater N
 * requests por request. `now` é injetável para testes determinísticos.
 */

import type { ProviderAdapter } from "./types.js";

export interface ProviderHealthReport {
  provider: string;
  healthy: boolean;
  /** Tempo do health-check em ms, ou null se o adapter não expõe health(). */
  latencyMs: number | null;
  error?: string;
  checkedAt: string;
}

export interface FilterHealthyOptions {
  /** Timeout por chamada de health() (ms). Default 5000. */
  timeoutMs?: number;
  /** Validade do resultado em cache (ms). Default 30_000. */
  ttlMs?: number;
  /** Relógio injetável (ms epoch) — testes determinísticos. */
  now?: () => number;
}

export type HealthChecker = (
  providers: Map<string, ProviderAdapter>,
  options?: FilterHealthyOptions
) => Promise<{
  available: Map<string, ProviderAdapter>;
  reports: ProviderHealthReport[];
}>;

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_TTL_MS = 30_000;

interface CachedReport {
  report: ProviderHealthReport;
  expiresAt: number;
}

const cache = new Map<string, CachedReport>();

/**
 * Checa a saúde de um único adapter e monta o report.
 * Adapter sem `health()` → saudável por padrão (zero rede).
 */
export async function checkProviderHealth(
  adapter: ProviderAdapter,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<ProviderHealthReport> {
  const startedAt = Date.now();

  if (!adapter.health) {
    return {
      provider: adapter.name,
      healthy: true,
      latencyMs: null,
      checkedAt: new Date().toISOString(),
    };
  }

  try {
    await adapter.health(timeoutMs);
    return {
      provider: adapter.name,
      healthy: true,
      latencyMs: Date.now() - startedAt,
      checkedAt: new Date().toISOString(),
    };
  } catch (error) {
    return {
      provider: adapter.name,
      healthy: false,
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
      checkedAt: new Date().toISOString(),
    };
  }
}

/**
 * Filtra o registry para os provedores saudáveis, com cache por TTL.
 * O `Map` retornado é NOVO (não muta o original).
 */
export async function filterHealthyProviders(
  providers: Map<string, ProviderAdapter>,
  options: FilterHealthyOptions = {}
): Promise<{
  available: Map<string, ProviderAdapter>;
  reports: ProviderHealthReport[];
}> {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? Date.now;

  const available = new Map<string, ProviderAdapter>();
  const reports: ProviderHealthReport[] = [];

  const entries = Array.from(providers.entries());
  const results = await Promise.all(
    entries.map(async ([name, adapter]) => {
      const cached = cache.get(name);
      if (cached && cached.expiresAt > now()) {
        return cached.report;
      }

      const report = await checkProviderHealth(adapter, timeoutMs);
      cache.set(name, { report, expiresAt: now() + ttlMs });
      return report;
    })
  );

  for (let i = 0; i < entries.length; i++) {
    const [name, adapter] = entries[i] as [string, ProviderAdapter];
    const report = results[i] as ProviderHealthReport;
    reports.push(report);
    if (report.healthy) {
      available.set(name, adapter);
    }
  }

  return { available, reports };
}

/** Limpa o cache — usado em testes e quando o registry é reconstruído. */
export function clearHealthCache(): void {
  cache.clear();
}
