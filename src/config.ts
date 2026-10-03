import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  // Chaves aceitas para autenticar CONTRA este gateway (não são as chaves dos provedores).
  // Formato: lista separada por vírgula. Ex: "chave-do-time-a,chave-do-time-b"
  GATEWAY_API_KEYS: z
    .string()
    .default("dev-key")
    .transform((val) => val.split(",").map((k) => k.trim()).filter(Boolean)),

  // Chaves dos provedores de IA de verdade
  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  GROQ_API_KEY: z.string().optional(),

  // Rate limiting: N requisições por janela de tempo, por chave de API
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().default(20),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60_000),

  // Cache de respostas não-streaming
  CACHE_TTL_MS: z.coerce.number().default(5 * 60_000),
  CACHE_MAX_ENTRIES: z.coerce.number().default(500),

  // Timeout máximo de execução do /v1/run (F4-F9), em ms. O loop autônomo
  // (F6) pode legitimamente precisar de várias iterações com chamadas de
  // LLM cada uma — o default de 10 minutos é uma proteção contra loops
  // travados, não um limite artificial para tarefas normais. Ajuste para
  // cima se suas tarefas autônomas rotineiramente excedem esse tempo
  // (lembre que proxies/load balancers na frente da API podem ter seu
  // próprio timeout de conexão, independente deste valor).
  RUN_TIMEOUT_MS: z.coerce.number().default(10 * 60_000),

  // Redis opcional: se definido, cache e rate limiting passam a ser
  // distribuídos (compartilhados entre réplicas) em vez de em memória.
  // Ex: redis://localhost:6379
  REDIS_URL: z.string().optional(),

  // Raiz de trabalho onde o agente opera tools de filesystem/shell/http.
  // Default: cwd do processo (o "workspace". Em Docker, WORKDIR=/app. Configure
  // para apontar para um volume seguros se não quiser que o agente mexa no cwd.
  AXON_WORKSPACE: z.string().optional(),

  // Health-check de provedores (Fase 2). OFF por padrão: quando ativado,
  // `/v1/decide` verifica em runtime quais provedores estão saudáveis
  // (GET /models do provider) antes de escolher o modelo. Resultados são
  // cacheados por HEALTH_CHECK_TTL_MS.
  HEALTH_CHECK_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  HEALTH_CHECK_TTL_MS: z.coerce.number().default(30_000),

  // Tamanho máximo aceito para upload de arquivos (POST /v1/files/upload),
  // em MB. O default do Fastify/@fastify/multipart é 1 MiB, pequeno demais
  // para anexos reais (.rar, .pdf, imagens de câmera etc.) — por isso um
  // default bem mais generoso aqui. Ajuste conforme a capacidade do seu
  // ambiente (memória disponível: o arquivo inteiro é bufferizado em RAM).
  MAX_UPLOAD_SIZE_MB: z.coerce.number().default(100),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    console.error("Variáveis de ambiente inválidas:", parsed.error.flatten().fieldErrors);
    throw new Error("Configuração de ambiente inválida.");
  }
  return parsed.data;
}
