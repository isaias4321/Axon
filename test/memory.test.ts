import { describe, expect, it } from "vitest";

import {
  DEFAULT_MAX_TURNS_PER_SESSION,
  InMemorySessionStore,
  type MemoryTurn,
} from "../src/adaptive/memory.js";

function turn(role: MemoryTurn["role"], content: string): MemoryTurn {
  return { role, content };
}

describe("InMemorySessionStore", () => {
  it("remember + recall preservam a ordem dos turnos", () => {
    const store = new InMemorySessionStore();

    store.remember("s1", turn("user", "Oi"));
    store.remember("s1", turn("assistant", "Olá!"));

    expect(store.recall("s1")).toEqual([
      { role: "user", content: "Oi" },
      { role: "assistant", content: "Olá!" },
    ]);
  });

  it("recall de sessão inexistente → array vazio (sem lançar)", () => {
    const store = new InMemorySessionStore();
    expect(store.recall("sessao-desconhecida")).toEqual([]);
  });

  it("sessões são isoladas entre si", () => {
    const store = new InMemorySessionStore();

    store.remember("a", turn("user", "A"));
    store.remember("b", turn("user", "B"));

    expect(store.recall("a")).toHaveLength(1);
    expect(store.recall("b")).toHaveLength(1);
    expect(store.recall("a")[0]?.content).toBe("A");
  });

  it("respeita o limite FIFO — o turno mais antigo sai", () => {
    const store = new InMemorySessionStore(2);

    store.remember("s1", turn("user", "1"));
    store.remember("s1", turn("user", "2"));
    store.remember("s1", turn("assistant", "3"));

    expect(store.recall("s1")).toEqual([
      { role: "user", content: "2" },
      { role: "assistant", content: "3" },
    ]);
  });

  it("clearSession esvazia a sessão", () => {
    const store = new InMemorySessionStore();
    store.remember("s1", turn("user", "1"));
    store.clearSession("s1");

    expect(store.recall("s1")).toEqual([]);
  });

  it("clearSession de sessão inexistente não lança", () => {
    const store = new InMemorySessionStore();
    expect(() => store.clearSession("nada")).not.toThrow();
  });

  it("default de limite é DEFAULT_MAX_TURNS_PER_SESSION", () => {
    expect(DEFAULT_MAX_TURNS_PER_SESSION).toBe(10);

    const store = new InMemorySessionStore();
    for (let i = 0; i < 15; i++) {
      store.remember("s1", turn("user", `turno ${i}`));
    }

    expect(store.recall("s1")).toHaveLength(10);
    expect(store.recall("s1")[0]?.content).toBe("turno 5");
  });
});
