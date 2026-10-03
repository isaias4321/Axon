import { describe, expect, it, vi } from "vitest";
import { ProviderHttpError, withRetry } from "../src/lib/retry.js";

describe("withRetry", () => {
  it("retorna o resultado direto quando a primeira tentativa funciona", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(fn);

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("tenta novamente em erro 429 e eventualmente ter sucesso", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new ProviderHttpError("rate limited", 429))
      .mockResolvedValueOnce("ok");

    const result = await withRetry(fn, { baseDelayMs: 1, maxDelayMs: 5 });

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("não tenta novamente em erro 400 (erro do cliente)", async () => {
    const fn = vi.fn().mockRejectedValue(new ProviderHttpError("bad request", 400));

    await expect(withRetry(fn, { baseDelayMs: 1 })).rejects.toThrow("bad request");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("considera Retry-After no atraso do rate limit", async () => {
    vi.useFakeTimers();
    try {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new ProviderHttpError("rate limited", 429, false, 1000))
        .mockResolvedValueOnce("ok");
      const promise = withRetry(fn, { baseDelayMs: 1, maxDelayMs: 5 });

      await vi.advanceTimersByTimeAsync(999);
      expect(fn).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(promise).resolves.toBe("ok");
      expect(fn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("desiste após maxAttempts tentativas", async () => {
    const fn = vi.fn().mockRejectedValue(new ProviderHttpError("server error", 500));

    await expect(withRetry(fn, { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 5 })).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("respeita uma função shouldRetry customizada", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("erro específico"));
    const shouldRetry = vi.fn().mockReturnValue(false);

    await expect(withRetry(fn, { shouldRetry, baseDelayMs: 1 })).rejects.toThrow(
      "erro específico"
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
