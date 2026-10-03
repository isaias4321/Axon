/**
 * Fase 6 — Database Driver SQLite.
 *
 * Usa `node:sqlite` (Node >= 22.5), sem addon nativo externo. Isso mantém a
 * memória long-term funcional também em instalações onde o npm bloqueia scripts
 * de compilação de dependências opcionais.
 */

import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";
import { getDbPath } from "./paths.js";

export interface DatabaseDriver {
  exec(sql: string): void;
  prepare(sql: string): PreparedStatement;
  close(): void;
  transaction<T>(fn: () => T): T;
}

export interface PreparedStatement {
  run(...params: SQLInputValue[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: SQLInputValue[]): unknown;
  all(...params: SQLInputValue[]): unknown[];
  iterate(...params: SQLInputValue[]): IterableIterator<unknown>;
}

let driver: DatabaseDriver | null = null;

class NodeSqliteDriver implements DatabaseDriver {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA busy_timeout = 5000");
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  prepare(sql: string): PreparedStatement {
    const statement = this.db.prepare(sql);
    return {
      run: (...params: SQLInputValue[]) => {
        const result = statement.run(...params);
        return {
          changes: Number(result.changes),
          lastInsertRowid: result.lastInsertRowid,
        };
      },
      get: (...params: SQLInputValue[]) => statement.get(...params),
      all: (...params: SQLInputValue[]) => statement.all(...params),
      iterate: (...params: SQLInputValue[]) => statement.iterate(...params),
    };
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

/** Inicializa e retorna o driver singleton. */
export function getDriver(): DatabaseDriver {
  if (!driver) {
    driver = new NodeSqliteDriver(getDbPath());
  }
  return driver;
}

/** Permite injeção de driver em testes unitários. */
export function setDriverForTest(nextDriver: DatabaseDriver | null): void {
  driver = nextDriver;
}

/**
 * Cria um driver SQLite em memória (isolado por teste).
 * Usado nos testes de persistência para evitar corrida entre arquivos
 * quando o vitest roda arquivos de teste em paralelo.
 */
export function createInMemoryDriver(): DatabaseDriver {
  return new NodeSqliteDriver(":memory:");
}

export function getDriverName(): string {
  return "node:sqlite";
}