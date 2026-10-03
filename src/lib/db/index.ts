/**
 * Fase 6 — Camada de persistência SQLite para Autonomous Behavior.
 *
 * Exporta: paths, driver, migrations, repos.
 * Inicialização lazy: o banco é criado na primeira chamada a getDriver().
 */

export * from "./paths.js";
export * from "./driver.js";
export * from "./migrations.js";
export * from "./repos.js";
export * from "./sessionRepo.js";