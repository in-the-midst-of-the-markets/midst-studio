import { afterEach, describe, expect, test } from "bun:test";
import { DEFAULT_ASSIST_SETTINGS, writeAssistSettings } from "@/lib/ai/assist-settings";
import {
  EMBED_ID_CONNECTION,
  EMBED_ID_EMPTY,
  EMBED_ID_FULL,
  EMBED_ID_LONG,
  EMBED_ID_UNSAVED,
  createEmbeddingId,
  embeddingBindsFor,
  embeddingRequestFields,
  setEmbeddingIdStorage,
} from "@/lib/embeddings/ids";
import { setEmbeddingStorage } from "@/lib/embeddings/settings";

class MemoryStorage implements Storage {
  private readonly items = new Map<string, string>();
  get length(): number {
    return this.items.size;
  }
  clear(): void {
    this.items.clear();
  }
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.items.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.items.delete(key);
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
}

const KEY = "libredb_embedding_ids";

function install(): MemoryStorage {
  const storage = new MemoryStorage();
  setEmbeddingIdStorage(storage);
  setEmbeddingStorage(new MemoryStorage());
  return storage;
}

describe("embed ids", () => {
  afterEach(() => {
    setEmbeddingIdStorage(undefined);
    setEmbeddingStorage(undefined);
  });

  test("gives the next id and sends that text only when the statement names it", () => {
    install();
    expect(createEmbeddingId(undefined, "cats")).toEqual({ ok: false, error: EMBED_ID_CONNECTION });
    expect(createEmbeddingId("  ", "cats")).toEqual({ ok: false, error: EMBED_ID_CONNECTION });
    expect(createEmbeddingId("k".repeat(201), "cats")).toEqual({ ok: false, error: EMBED_ID_CONNECTION });
    expect(createEmbeddingId("orders", "   ")).toEqual({ ok: false, error: EMBED_ID_EMPTY });
    expect(createEmbeddingId("orders", "a".repeat(4001))).toEqual({ ok: false, error: EMBED_ID_LONG });

    const first = createEmbeddingId(" orders ", " cats ");
    const second = createEmbeddingId("orders", "cats");
    expect(first).toEqual({ ok: true, id: "e1", token: "{{embed e1}}" });
    expect(second).toEqual({ ok: true, id: "e2", token: "{{embed e2}}" });
    expect(embeddingBindsFor("orders", "knn('{{embed e1}}', '{{embed e1}}') AND {{embed missing}}")).toEqual([
      { name: "e1", value: "cats" },
    ]);
    expect(embeddingBindsFor("other", "{{embed e1}}")).toEqual([]);
    expect(embeddingBindsFor("  ", "{{embed e1}}")).toEqual([]);
    writeAssistSettings(DEFAULT_ASSIST_SETTINGS);
    expect(embeddingRequestFields("orders", "SELECT 1")).toEqual({ embeddingModel: "voyage-4" });
    expect(embeddingRequestFields("orders", "{{embed e2}}")).toEqual({
      embeddingModel: "voyage-4",
      embeddingBinds: [{ name: "e2", value: "cats" }],
    });
    writeAssistSettings({ ...DEFAULT_ASSIST_SETTINGS, source: "fireworks", fireworksKey: " fw-key " });
    expect(embeddingRequestFields("orders", "SELECT 1")).toEqual({ embeddingModel: "voyage-4" });
    expect(embeddingRequestFields("orders", '{{embed "cats"}}')).toEqual({
      embeddingModel: "voyage-4",
      embeddingSource: "fireworks",
      embeddingKey: "fw-key",
    });
    writeAssistSettings({ ...DEFAULT_ASSIST_SETTINGS, source: "gateway", gatewayKey: "gw-key" });
    expect(embeddingRequestFields("orders", '{{embed "cats"}}').embeddingKey).toBe("gw-key");
    writeAssistSettings({ ...DEFAULT_ASSIST_SETTINGS, openRouterKey: "or-key" });
    expect(embeddingRequestFields("orders", "{{embed e2}}")).toEqual({
      embeddingModel: "voyage-4",
      embeddingBinds: [{ name: "e2", value: "cats" }],
      embeddingSource: "openrouter",
      embeddingKey: "or-key",
    });
    writeAssistSettings(DEFAULT_ASSIST_SETTINGS);
  });

  test("drops the oldest id and the oldest connection, and ignores a stored list it cannot use", () => {
    const storage = install();
    for (let index = 0; index < 64; index += 1) {
      expect(createEmbeddingId("orders", `t${index}`).ok).toBe(true);
    }
    expect(createEmbeddingId("orders", "newest").ok).toBe(true);
    expect(embeddingBindsFor("orders", "{{embed e1}}")).toEqual([]);
    expect(embeddingBindsFor("orders", "{{embed e65}}")).toEqual([{ name: "e65", value: "newest" }]);

    for (let index = 0; index < 200; index += 1) {
      expect(createEmbeddingId(`c${index}`, "text").ok).toBe(true);
    }
    expect(embeddingBindsFor("orders", "{{embed e65}}")).toEqual([]);
    expect(embeddingBindsFor("c0", "{{embed e1}}")).toEqual([{ name: "e1", value: "text" }]);
    expect(embeddingBindsFor("c199", "{{embed e1}}")).toEqual([{ name: "e1", value: "text" }]);

    storage.setItem(
      KEY,
      JSON.stringify({
        byConnection: {
          ...Object.fromEntries(Array.from({ length: 201 }, (_, index) => [`n${index}`, [{ id: "e1", text: "old" }]])),
          "": [{ id: "e1", text: "skip" }],
          ["k".repeat(201)]: [{ id: "e1", text: "skip" }],
          orders: [
            ...Array.from({ length: 65 }, (_, index) => ({ id: `e${index + 1}`, text: `t${index}` })),
            { id: "nope", text: "x" },
            { id: "e2", text: "" },
            { id: "e3", text: "a".repeat(4001) },
            { id: "e4", text: 4 },
            ["e5"],
            { id: "e9", text: " kept " },
          ],
          empty: [],
        },
      }),
    );
    expect(embeddingBindsFor("n0", "{{embed e1}}")).toEqual([]);
    expect(embeddingBindsFor("orders", "{{embed e9}}")).toEqual([{ name: "e9", value: "kept" }]);
    expect(embeddingBindsFor("orders", "{{embed e1}}")).toEqual([]);
    expect(embeddingBindsFor("", "{{embed e9}}")).toEqual([]);

    storage.setItem(KEY, "not-json");
    expect(embeddingBindsFor("orders", "{{embed e1}}")).toEqual([]);
    storage.setItem(KEY, "null");
    expect(embeddingBindsFor("orders", "{{embed e1}}")).toEqual([]);
    storage.setItem(KEY, "[]");
    expect(embeddingBindsFor("orders", "{{embed e1}}")).toEqual([]);
    storage.setItem(KEY, JSON.stringify({ byConnection: [] }));
    expect(embeddingBindsFor("orders", "{{embed e1}}")).toEqual([]);
    storage.setItem(KEY, JSON.stringify({ byConnection: { orders: { id: "e1" } } }));
    expect(embeddingBindsFor("orders", "{{embed e1}}")).toEqual([]);

    storage.setItem(KEY, JSON.stringify({ byConnection: { orders: [{ id: "e999999999", text: "full" }] } }));
    expect(createEmbeddingId("orders", "more")).toEqual({ ok: false, error: EMBED_ID_FULL });
    expect(embeddingBindsFor("orders", "{{embed e999999999}}")).toEqual([{ name: "e999999999", value: "full" }]);
  });

  test("keeps the previous id when the browser refuses the write or has no storage", () => {
    const storage = install();
    expect(createEmbeddingId("orders", "cats")).toEqual({ ok: true, id: "e1", token: "{{embed e1}}" });
    storage.setItem = () => {
      throw new Error("full");
    };
    expect(createEmbeddingId("orders", "dogs")).toEqual({ ok: false, error: EMBED_ID_UNSAVED });
    expect(embeddingBindsFor("orders", "{{embed e1}}")).toEqual([{ name: "e1", value: "cats" }]);

    const locked = new MemoryStorage();
    locked.getItem = () => {
      throw new Error("locked");
    };
    setEmbeddingIdStorage(locked);
    expect(embeddingBindsFor("orders", "{{embed e1}}")).toEqual([]);
    expect(createEmbeddingId("orders", "cats")).toEqual({ ok: true, id: "e1", token: "{{embed e1}}" });

    setEmbeddingIdStorage(null);
    expect(createEmbeddingId("orders", "cats")).toEqual({ ok: false, error: EMBED_ID_UNSAVED });
    expect(embeddingBindsFor("orders", "{{embed e1}}")).toEqual([]);

    setEmbeddingIdStorage(undefined);
    expect(embeddingBindsFor("orders", "{{embed e1}}")).toEqual([]);
  });
});
