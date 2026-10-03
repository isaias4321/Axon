/**
 * Fase 9 — HTTP route test for the Cognitive Cells API.
 *
 * Valida que `/v1/cognitive` e `/v1/cognitive/health` estão corretamente
 * expostas via Fastify (auth via x-api-key obrigatoria), e que o fluxo
 * determinístico (router + cells reais) responde como esperado.
 */

import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import authPlugin from "../src/plugins/auth.js";
import cognitiveRoute from "../src/routes/cognitive.js";

const VALID_KEY = "test-key";

function buildTestApp() {
  const fastify = Fastify({ logger: false });
  fastify.register(authPlugin, { validKeys: [VALID_KEY] });
  fastify.register(cognitiveRoute);

  return { fastify };
}

describe("Fase 9 — Cognitive HTTP routes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("POST /v1/cognitive rejeita requisição sem chave de API (401)", async () => {
    const { fastify } = buildTestApp();
    const response = await fastify.inject({
      method: "POST",
      url: "/v1/cognitive",
      payload: { task: "investigar erro 429 no rate limiter" },
    });

    expect(response.statusCode).toBe(401);
  });

  it("POST /v1/cognitive rejeita chave inválida (401)", async () => {
    const { fastify } = buildTestApp();
    const response = await fastify.inject({
      method: "POST",
      url: "/v1/cognitive",
      headers: { "x-api-key": "chave-errada" },
      payload: { task: "investigar erro 429 no rate limiter" },
    });

    expect(response.statusCode).toBe(401);
  });

  it("POST /v1/cognitive rejeita corpo sem 'task' (400)", async () => {
    const { fastify } = buildTestApp();
    const response = await fastify.inject({
      method: "POST",
      url: "/v1/cognitive",
      headers: { "x-api-key": VALID_KEY },
      payload: {},
    });

    expect(response.statusCode).toBe(400);
  });

  it("POST /v1/cognitive rotea tarefa de debug via cells reais (200, routerUsed=true)", async () => {
    const { fastify } = buildTestApp();
    const response = await fastify.inject({
      method: "POST",
      url: "/v1/cognitive",
      headers: { "x-api-key": VALID_KEY },
      payload: {
        task: "investigar erro 429 no rate limiter e planejar a correção com Redis distribuído",
        forceRouter: true,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{
      routerUsed: boolean;
      classification?: {
        primaryCellType: string;
        secondaryCellTypes: string[];
      };
      allSuccessful: boolean;
      cellResults: Record<string, unknown>;
    }>();

    expect(body.routerUsed).toBe(true);
    expect(body.classification?.primaryCellType).toBe("debug");
    expect(body.classification?.secondaryCellTypes).toContain("planning");
    expect(body.allSuccessful).toBe(true);
    expect(Object.keys(body.cellResults).length).toBeGreaterThan(0);
  });

  it("POST /v1/cognitive delega ao agente padrão para intent genérico (routerUsed=false)", async () => {
    const { fastify } = buildTestApp();
    const response = await fastify.inject({
      method: "POST",
      url: "/v1/cognitive",
      headers: { "x-api-key": VALID_KEY },
      payload: { task: "olá, tudo bem?", forceRouter: false },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ routerUsed: boolean; cellResults: Record<string, unknown> }>();
    expect(body.routerUsed).toBe(false);
    expect(Object.keys(body.cellResults).length).toBe(0);
  });

  it("GET /v1/cognitive/health responde com sistema saudable (200)", async () => {
    const { fastify } = buildTestApp();
    const response = await fastify.inject({
      method: "GET",
      url: "/v1/cognitive/health",
      headers: { "x-api-key": VALID_KEY },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{
      healthy: boolean;
      routerRegisteredCells: number;
      cells: Array<{ id: string; healthy: boolean }>;
    }>();

    expect(body.healthy).toBe(true);
    expect(body.routerRegisteredCells).toBeGreaterThan(0);
    expect(body.cells.length).toBe(body.routerRegisteredCells);
    expect(body.cells.every((c) => c.healthy)).toBe(true);
  });
});