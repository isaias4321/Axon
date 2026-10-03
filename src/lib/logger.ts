import pino from "pino";
import type { Env } from "../config.js";

export function createLogger(env: Pick<Env, "LOG_LEVEL">) {
  const isProduction = process.env["NODE_ENV"] === "production";

  return pino({
    level: env.LOG_LEVEL,
    transport: isProduction
      ? undefined
      : { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } },
  });
}

export type Logger = ReturnType<typeof createLogger>;

let defaultLogger: Logger | null = null;

/**
 * Logger padrão para módulos que não recebem um logger injetado pela aplicação
 * (ex: adapters de provedores e células cognitivas). Usa o mesmo motor oficial
 * (pino), sem transport para não spawnar worker — logs structurados em JSON,
 * consistentes com o restante do sistema e sem `console.*` espalhado no código.
 */
export function getDefaultLogger(): Logger {
  if (!defaultLogger) {
    defaultLogger = pino({
      level: process.env["LOG_LEVEL"] ?? "info",
      base: undefined,
    });
  }
  return defaultLogger;
}
