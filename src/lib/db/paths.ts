/**
 * Fase 6 — Caminhos do banco de dados.
 *
 * Resolve o diretório de dados para o SQLite. Segue o mesmo padrão
 * do gateway: variável de ambiente DATA_DIR ou fallback para ~/.axon/.
 */

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function getDataDir(): string {
  if (process.env.DATA_DIR) {
    return process.env.DATA_DIR;
  }
  return join(homedir(), ".axon");
}

export function getDbPath(): string {
  const dataDir = getDataDir();
  mkdirSync(dataDir, { recursive: true });
  return join(dataDir, "autonomous.db");
}