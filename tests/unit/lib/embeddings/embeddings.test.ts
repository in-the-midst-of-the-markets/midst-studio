import { describe, expect, test } from "bun:test";
import {
  EMBED_COUNT_ERROR,
  EMBED_LENGTH_ERROR,
  EMBED_UNREADABLE_ERROR,
  EMBED_UNREACHABLE_ERROR,
  EMBED_VECTOR_ERROR,
  EMBEDDING_KEY_ERROR,
  EMBEDDING_URL_ERROR,
  FIREWORKS_EMBEDDINGS_URL,
  GATEWAY_EMBEDDINGS_URL,
  OPENROUTER_EMBEDDINGS_URL,
  VOYAGE_EMBEDDINGS_URL,
  VOYAGE_KEY_ERROR,
  embedTexts,
  embeddingEndpoint,
} from "@/lib/embeddings/client";
import {
  EMBED_EMPTY_ERROR,
  EMBED_KEY_ERROR,
  EMBED_LONG_ERROR,
  EMBED_SOURCE_ERROR,
  EMBED_TOO_MANY_ERROR,
  auditTextAt,
  EMBED_BINDS_ERROR,
  embedNameError,
  expandQueryEmbeddings,
  expandSubmittedEmbeddings,
  readEmbeddingAuth,
  readEmbeddingBinds,
} from "@/lib/embeddings/expand";
import {
  CUSTOM_EMBEDDING_CHOICE,
  DEFAULT_EMBEDDING_MODEL,
  embeddingModelOf,
  isListedEmbeddingModel,
  isVoyageModel,
  normalizeEmbeddingModel,
  voyageModelId,
} from "@/lib/embeddings/models";
import {
  bindEmbedPlaceholders,
  bindVectorFilterIds,
  embedProbeText,
  embedTokens,
  spliceEmbeddingVectors,
} from "@/lib/embeddings/placeholder";
import {
  DEFAULT_EMBEDDING_SETTINGS,
  embeddingModelFor,
  readEmbeddingSettings,
  setEmbeddingStorage,
  subscribeEmbeddingSettings,
  writeEmbeddingModel,
} from "@/lib/embeddings/settings";

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

function installStorage(): MemoryStorage {
  const storage = new MemoryStorage();
  setEmbeddingStorage(storage);
  return storage;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("embedding models", () => {
  test("keeps a usable model id and falls back to Voyage 4", () => {
    expect(normalizeEmbeddingModel(" voyage-4-lite ")).toBe("voyage-4-lite");
    expect(normalizeEmbeddingModel("voyageai/voyage-4")).toBe("voyageai/voyage-4");
    expect(normalizeEmbeddingModel("a".repeat(128))).toBe("a".repeat(128));
    expect(normalizeEmbeddingModel("a".repeat(129))).toBe(DEFAULT_EMBEDDING_MODEL);
    expect(normalizeEmbeddingModel("bad model")).toBe(DEFAULT_EMBEDDING_MODEL);
    expect(normalizeEmbeddingModel("")).toBe(DEFAULT_EMBEDDING_MODEL);
    expect(normalizeEmbeddingModel(4)).toBe(DEFAULT_EMBEDDING_MODEL);
    expect(normalizeEmbeddingModel(CUSTOM_EMBEDDING_CHOICE)).toBe(DEFAULT_EMBEDDING_MODEL);
    expect(voyageModelId("voyageai/voyage-4")).toBe("voyage-4");
    expect(voyageModelId("voyage-4")).toBe("voyage-4");
    expect(isVoyageModel("voyage-4-large")).toBe(true);
    expect(isVoyageModel("voyageai/voyage-4")).toBe(true);
    expect(isVoyageModel("voyageai/")).toBe(false);
    expect(isVoyageModel("text-embedding-3-small")).toBe(false);
    expect(isListedEmbeddingModel("voyage-code-4")).toBe(true);
    expect(isListedEmbeddingModel("text-embedding-3-small")).toBe(false);
    expect(embeddingModelOf({})).toBe(DEFAULT_EMBEDDING_MODEL);
    expect(embeddingModelOf({ embeddingModel: "text-embedding-3-small" })).toBe("text-embedding-3-small");
    expect(embeddingModelOf({ embeddingModel: "bad model" })).toBe(DEFAULT_EMBEDDING_MODEL);
  });
});

describe("embed placeholders", () => {
  test("binds a dashboard name and leaves everything else", () => {
    const sql = '{{embed question}} AND {{embed "kept"}} AND {{embed missing}} AND {{embed city}}';
    expect(
      bindEmbedPlaceholders(sql, [
        { name: "question", value: 'cats "and" dogs' },
        { name: "missing", value: "   " },
        { name: "bad name", value: "nope" },
        { name: "a".repeat(41), value: "too-long" },
        { name: "city", value: ` ${"b".repeat(4001)} ` },
      ]),
    ).toBe(
      `{{embed "cats \\"and\\" dogs"}} AND {{embed "kept"}} AND {{embed missing}} AND {{embed "${"b".repeat(4000)}"}}`,
    );
  });

  test("reads a quoted string, a name, and skips a token that is not an embed", () => {
    expect(
      embedTokens('{{embedding}} {{embed "say \\"hi\\""}} {{embed  question}}').map((token) => ({
        kind: token.kind,
        value: token.value,
      })),
    ).toEqual([
      { kind: "text", value: 'say "hi"' },
      { kind: "name", value: "question" },
    ]);
    expect(embedTokens('{{embed "\\q"}} {{embed "abc')).toEqual([]);
    expect(embedTokens('{{embed "\\')).toEqual([]);
    expect(spliceEmbeddingVectors('{{embed "a"}} {{embed "b"}}', [[1]])).toBe('[1] {{embed "b"}}');
    expect(spliceEmbeddingVectors('{"vector": "{{embed "cats"}}"}', [[0.25, 0.5]])).toBe('{"vector": [0.25,0.5]}');
    expect(spliceEmbeddingVectors('{"vector": {{embed "cats"}}}', [[0.25, 0.5]])).toBe('{"vector": [0.25,0.5]}');
    expect(spliceEmbeddingVectors('"note {{embed "cats"}}"', [[1]])).toBe('"note [1]"');
    expect(embedProbeText('{"vector": "{{embed e1}}"}')).toBe('{"vector": [0]}');
    expect(embedProbeText('{"vector": {{embed e1}}}')).toBe('{"vector": [0]}');
    expect(embedProbeText("SELECT 1")).toBe("SELECT 1");
    const bound = bindEmbedPlaceholders('{"vector": "{{embed e1}}"}', [{ name: "e1", value: "cats" }]);
    expect(spliceEmbeddingVectors(bound, [[0.25, 0.5]])).toBe('{"vector": [0.25,0.5]}');
  });

  test("embeds {{text}} only in the vector value and leaves other filters", () => {
    const sql = [
      '{"vector": {{a red mug}}, "data": [{{cats}}, "{{dogs}}"], "nearest": {{cats}}, "data": []}',
      '{"query": [{{"quoted"}}], "query": {"title": {{title}}}, "query": "hello", "query": "{{kept}}"}',
      "knn(foo(a, 'b, c'), {{cats}}, 10)",
      "KNN_SCORE(vec, '{{cats}}', 4)",
      'knn(vec, "{{cats}}", 4)',
      "knn('a\\\\b', {{cats}}, 4)",
      "knn(vec, 'plain', 4)",
      "knn(vec, [1, 2], 4)",
      "knn('no-comma')",
      "knn('unterminated)",
      'knn(vec, {{embed "x"}}, 1)',
      '{"vector": {{embed "cats"}}, "vector": {{"hi"}}, "vector": {{"abc}}, "vector": 1, "vector": true, "vector": nope}',
      '{"data": [-2.5, true, false, null, {"a": 1}, [1], "a\\"b", {{cats}}, foo]}',
      '{"data": [{{cats}]}',
      '{"vector": [1}',
      '{"vector": "nope}',
      '{"vector": {{open}',
      "SELECT {{title}} FROM t WHERE region = {{region}}",
      '{"vector": {{tail',
    ].join("\n");
    expect(embedTokens(sql).map((token) => token.value)).toEqual([
      "a red mug",
      "cats",
      "dogs",
      "cats",
      "quoted",
      "kept",
      "cats",
      "cats",
      "cats",
      "cats",
      "x",
      "cats",
      "hi",
      '"abc',
      "cats",
    ]);
    expect(embedProbeText('{"vector": "{{a red mug}}", "data": [{{cats}}]}')).toBe('{"vector": [0], "data": [[0]]}');
    expect(spliceEmbeddingVectors('{"vector": {{a red mug}}}', [[0.25, 0.5]])).toBe('{"vector": [0.25,0.5]}');
    expect(spliceEmbeddingVectors('{"vector": "{{a red mug}}"}', [[0.25, 0.5]])).toBe('{"vector": [0.25,0.5]}');
    expect(
      bindEmbedPlaceholders('{"vector": {{cats}}} AND {{embed question}}', [{ name: "question", value: "dogs" }]),
    ).toBe('{"vector": {{cats}}} AND {{embed "dogs"}}');
    expect(
      bindVectorFilterIds('{"vector": {{vq_abc}}, "vector": {{a red mug}}}', [
        { name: "vq_abc", value: "ceramic mug" },
        { name: "empty", value: "   " },
        { name: "bad name", value: "nope" },
      ]),
    ).toBe('{"vector": {{embed "ceramic mug"}}, "vector": {{a red mug}}}');
    expect(bindVectorFilterIds('{"vector": {{empty}}}', [{ name: "empty", value: "  " }])).toBe(
      '{"vector": {{embed empty}}}',
    );
    expect(bindVectorFilterIds("SELECT {{region}}", [{ name: "region", value: "east" }])).toBe("SELECT {{region}}");
  });
});

describe("expandQueryEmbeddings", () => {
  const savedKey = process.env.VOYAGE_API_KEY;
  const savedEmbeddingKey = process.env.EMBEDDING_API_KEY;

  test("splices one vector for repeated text and keeps a quoted call quoted", async () => {
    const savedOpenRouter = process.env.OPENROUTER_API_KEY;
    const savedUrl = process.env.EMBEDDING_API_URL;
    process.env.VOYAGE_API_KEY = "test-key";
    delete process.env.EMBEDDING_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.EMBEDDING_API_URL;
    let sent: { model?: string; input?: string[]; input_type?: string } = {};
    const fetchImpl = async (_url: RequestInfo | URL, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body)) as typeof sent;
      return jsonResponse({ data: [{ index: 0, embedding: [0.25, 0.5] }] });
    };
    try {
      const expanded = await expandQueryEmbeddings(
        'knn(\'{{embed "cats"}}\', 10) AND {{embed "cats"}}',
        "bad model",
        fetchImpl,
      );
      expect(expanded).toEqual({ ok: true, sql: "knn('[0.25,0.5]', 10) AND [0.25,0.5]" });
      expect(sent).toEqual({ model: "voyage-4", input: ["cats"], input_type: "query" });
      const plain = await expandQueryEmbeddings(
        '{"vector": {{cats}}} AND knn(vec, {{cats}}, 10)',
        "voyage-4",
        fetchImpl,
      );
      expect(plain).toEqual({ ok: true, sql: '{"vector": [0.25,0.5]} AND knn(vec, [0.25,0.5], 10)' });
    } finally {
      if (savedKey === undefined) delete process.env.VOYAGE_API_KEY;
      else process.env.VOYAGE_API_KEY = savedKey;
      if (savedEmbeddingKey === undefined) delete process.env.EMBEDDING_API_KEY;
      else process.env.EMBEDDING_API_KEY = savedEmbeddingKey;
      if (savedOpenRouter === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = savedOpenRouter;
      if (savedUrl === undefined) delete process.env.EMBEDDING_API_URL;
      else process.env.EMBEDDING_API_URL = savedUrl;
    }
  });

  test("refuses an empty, huge, unnamed, or crowded embed before calling the service", async () => {
    const fetchImpl = () => {
      throw new Error("should not be called");
    };
    expect(await expandQueryEmbeddings("SELECT 1", "voyage-4", fetchImpl)).toEqual({ ok: true, sql: "SELECT 1" });
    expect(await expandQueryEmbeddings('{{embed ""}}', "voyage-4", fetchImpl)).toEqual({
      ok: false,
      error: EMBED_EMPTY_ERROR,
    });
    expect(await expandQueryEmbeddings('{{embed "   "}}', "voyage-4", fetchImpl)).toEqual({
      ok: false,
      error: EMBED_EMPTY_ERROR,
    });
    expect(await expandQueryEmbeddings('{"vector": {{   }}}', "voyage-4", fetchImpl)).toEqual({
      ok: false,
      error: EMBED_EMPTY_ERROR,
    });
    expect(await expandQueryEmbeddings(`{"vector": {{${"a".repeat(4001)}}}`, "voyage-4", fetchImpl)).toEqual({
      ok: false,
      error: EMBED_LONG_ERROR,
    });
    expect(await expandQueryEmbeddings(`{{embed ${JSON.stringify("a".repeat(4001))}}}`, "voyage-4", fetchImpl)).toEqual(
      {
        ok: false,
        error: EMBED_LONG_ERROR,
      },
    );
    expect(await expandQueryEmbeddings("{{embed question}}", "voyage-4", fetchImpl)).toEqual({
      ok: false,
      error: embedNameError("question"),
    });
    const many = Array.from({ length: 33 }, (_, index) => `{{embed ${JSON.stringify(String(index))}}}`).join(" ");
    expect(await expandQueryEmbeddings(many, "voyage-4", fetchImpl)).toEqual({
      ok: false,
      error: EMBED_TOO_MANY_ERROR,
    });
    expect(auditTextAt(["SELECT 1"], 0, "fallback")).toBe("SELECT 1");
    expect(auditTextAt([], 0, "fallback")).toBe("fallback");
    expect(readEmbeddingBinds(undefined)).toEqual({ ok: true, binds: [] });
    expect(readEmbeddingBinds({})).toEqual({ ok: false, error: EMBED_BINDS_ERROR });
    expect(readEmbeddingBinds([null, "x"])).toEqual({ ok: false, error: EMBED_BINDS_ERROR });
    expect(readEmbeddingBinds([[]])).toEqual({ ok: false, error: EMBED_BINDS_ERROR });
    expect(readEmbeddingBinds([{ name: 1, value: "cats" }])).toEqual({ ok: false, error: EMBED_BINDS_ERROR });
    expect(readEmbeddingBinds(Array.from({ length: 33 }, () => ({ name: "e1", value: "cats" })))).toEqual({
      ok: false,
      error: EMBED_TOO_MANY_ERROR,
    });
    expect(readEmbeddingBinds([{ name: "e1", value: "cats" }])).toEqual({
      ok: true,
      binds: [{ name: "e1", value: "cats" }],
    });
    expect(await expandSubmittedEmbeddings("{{embed e1}}", { embeddingBinds: { name: "e1" } }, fetchImpl)).toEqual({
      ok: false,
      error: EMBED_BINDS_ERROR,
    });
    expect(readEmbeddingAuth({})).toEqual({ ok: true, apiKey: "" });
    expect(readEmbeddingAuth({ embeddingKey: 1 })).toEqual({ ok: false, error: EMBED_KEY_ERROR });
    expect(readEmbeddingAuth({ embeddingKey: "k".repeat(501) })).toEqual({ ok: false, error: EMBED_KEY_ERROR });
    expect(readEmbeddingAuth({ embeddingKey: " key ", embeddingSource: 1 })).toEqual({
      ok: false,
      error: EMBED_SOURCE_ERROR,
    });
    expect(readEmbeddingAuth({ embeddingKey: "key", embeddingSource: "nope" })).toEqual({
      ok: false,
      error: EMBED_SOURCE_ERROR,
    });
    expect(readEmbeddingAuth({ embeddingKey: " key ", embeddingSource: "fireworks" })).toEqual({
      ok: true,
      apiKey: "key",
      source: "fireworks",
    });
    expect(await expandSubmittedEmbeddings("{{embed e1}}", { embeddingKey: 4, embeddingBinds: [] }, fetchImpl)).toEqual(
      { ok: false, error: EMBED_KEY_ERROR },
    );
    expect(
      await expandSubmittedEmbeddings("{{embed e1}}", { embeddingBinds: [{ name: "e1", value: "" }] }, fetchImpl),
    ).toEqual({ ok: false, error: embedNameError("e1") });
  });

  test("embeds an id from the text sent beside the statement", async () => {
    process.env.VOYAGE_API_KEY = "test-key";
    try {
      const expanded = await expandSubmittedEmbeddings(
        "WHERE '{{embed e1}}'",
        { embeddingModel: "voyage-4", embeddingBinds: [{ name: "e1", value: "cats" }] },
        async () => new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 2] }] }), { status: 200 }),
      );
      expect(expanded).toEqual({ ok: true, sql: "WHERE '[1,2]'" });
    } finally {
      if (savedKey === undefined) delete process.env.VOYAGE_API_KEY;
      else process.env.VOYAGE_API_KEY = savedKey;
    }
  });

  test("embeds Voyage with the connector key sent on the query", async () => {
    const savedUrl = process.env.EMBEDDING_API_URL;
    process.env.VOYAGE_API_KEY = "voyage-key";
    delete process.env.EMBEDDING_API_URL;
    const calls: { url: string; body: string; authorization: string; referer: string; title: string }[] = [];
    const fetchImpl = async (url: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push({
        url: String(url),
        body: String(init?.body ?? ""),
        authorization: headers.get("Authorization") ?? "",
        referer: headers.get("HTTP-Referer") ?? "",
        title: headers.get("X-Title") ?? "",
      });
      return new Response(JSON.stringify({ data: [{ embedding: [0.5] }] }), { status: 200 });
    };
    try {
      const openrouter = await expandSubmittedEmbeddings(
        '{{embed "cats"}}',
        { embeddingKey: " or-key ", embeddingSource: "openrouter" },
        fetchImpl,
      );
      expect(openrouter).toEqual({ ok: true, sql: "[0.5]" });
      expect(calls[0]).toEqual({
        url: OPENROUTER_EMBEDDINGS_URL,
        body: JSON.stringify({ input: ["cats"], model: "voyageai/voyage-4" }),
        authorization: "Bearer or-key",
        referer: "https://midst.market",
        title: "KnowSQL",
      });
      const fireworks = await expandSubmittedEmbeddings(
        '{{embed "cats"}}',
        { embeddingKey: "fw-key", embeddingSource: "fireworks" },
        fetchImpl,
      );
      expect(fireworks.ok).toBe(true);
      expect(calls[1]?.url).toBe(FIREWORKS_EMBEDDINGS_URL);
      expect(calls[1]?.authorization).toBe("Bearer fw-key");
      expect(calls[1]?.referer).toBe("");
      const implied = await expandSubmittedEmbeddings('{{embed "cats"}}', { embeddingKey: "plain" }, fetchImpl);
      expect(implied.ok).toBe(true);
      expect(calls[2]?.url).toBe(OPENROUTER_EMBEDDINGS_URL);
      expect(calls[2]?.authorization).toBe("Bearer plain");
    } finally {
      if (savedKey === undefined) delete process.env.VOYAGE_API_KEY;
      else process.env.VOYAGE_API_KEY = savedKey;
      if (savedUrl === undefined) delete process.env.EMBEDDING_API_URL;
      else process.env.EMBEDDING_API_URL = savedUrl;
    }
  });

  test("returns the service error unchanged", async () => {
    process.env.VOYAGE_API_KEY = "test-key";
    try {
      const expanded = await expandQueryEmbeddings('{{embed "cats"}}', "voyageai/voyage-4", async () => {
        throw new Error("down");
      });
      expect(expanded).toEqual({ ok: false, error: EMBED_UNREACHABLE_ERROR });
    } finally {
      if (savedKey === undefined) delete process.env.VOYAGE_API_KEY;
      else process.env.VOYAGE_API_KEY = savedKey;
    }
  });
});

describe("embedTexts", () => {
  test("reads Voyage's key from the process environment when no env is passed", async () => {
    const savedVoyage = process.env.VOYAGE_API_KEY;
    const savedEmbedding = process.env.EMBEDDING_API_KEY;
    const savedUrl = process.env.EMBEDDING_API_URL;
    const savedOpenRouter = process.env.OPENROUTER_API_KEY;
    process.env.VOYAGE_API_KEY = "from-process";
    delete process.env.EMBEDDING_API_KEY;
    delete process.env.EMBEDDING_API_URL;
    delete process.env.OPENROUTER_API_KEY;
    try {
      expect(embeddingEndpoint("voyage-4")).toEqual({
        url: VOYAGE_EMBEDDINGS_URL,
        key: "from-process",
        voyage: true,
        model: "voyage-4",
      });
      const embedded = await embedTexts(["a"], "voyage-4", async () => jsonResponse({ data: [{ embedding: [1] }] }));
      expect(embedded).toEqual({ ok: true, vectors: [[1]] });
      process.env.OPENROUTER_API_KEY = " or-process ";
      expect(embeddingEndpoint("voyageai/voyage-4")).toEqual({
        url: OPENROUTER_EMBEDDINGS_URL,
        key: "or-process",
        voyage: false,
        model: "voyageai/voyage-4",
      });
      expect(embeddingEndpoint("openai/text-embedding-3-small")).toEqual({
        url: OPENROUTER_EMBEDDINGS_URL,
        key: "or-process",
        voyage: false,
        model: "openai/text-embedding-3-small",
      });
    } finally {
      if (savedVoyage === undefined) delete process.env.VOYAGE_API_KEY;
      else process.env.VOYAGE_API_KEY = savedVoyage;
      if (savedEmbedding === undefined) delete process.env.EMBEDDING_API_KEY;
      else process.env.EMBEDDING_API_KEY = savedEmbedding;
      if (savedUrl === undefined) delete process.env.EMBEDDING_API_URL;
      else process.env.EMBEDDING_API_URL = savedUrl;
      if (savedOpenRouter === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = savedOpenRouter;
    }
  });

  test("calls Voyage, a custom endpoint, or refuses when the key or URL is missing", async () => {
    const calls: { url: string; body: string; authorization: string }[] = [];
    const fetchImpl = async (url: RequestInfo | URL, init?: RequestInit) => {
      const body = String(init?.body ?? "");
      calls.push({
        url: String(url),
        body,
        authorization: new Headers(init?.headers).get("Authorization") ?? "",
      });
      const input = (JSON.parse(body) as { input: string[] }).input;
      if (input.length === 2) {
        return jsonResponse({
          data: [
            { index: 1, embedding: [2, 2] },
            { index: 0, embedding: [1, 1] },
          ],
        });
      }
      return jsonResponse({ data: [{ embedding: [3] }] });
    };

    expect(embeddingEndpoint("voyage-4", {})).toBe(VOYAGE_KEY_ERROR);
    expect(embeddingEndpoint("text-embedding-3-small", { VOYAGE_API_KEY: "voyage" })).toBe(EMBEDDING_URL_ERROR);
    expect(embeddingEndpoint("voyage-4", { EMBEDDING_API_URL: "https://embed.test/v1", VOYAGE_API_KEY: "   " })).toBe(
      EMBEDDING_KEY_ERROR,
    );
    expect(embeddingEndpoint("voyage-4", { EMBEDDING_API_URL: "   ", VOYAGE_API_KEY: " voyage " })).toEqual({
      url: VOYAGE_EMBEDDINGS_URL,
      key: "voyage",
      voyage: true,
      model: "voyage-4",
    });
    expect(
      embeddingEndpoint("text-embedding-3-small", {
        EMBEDDING_API_URL: "https://embed.test/v1/",
        EMBEDDING_API_KEY: "custom",
      }),
    ).toEqual({
      url: "https://embed.test/v1/embeddings",
      key: "custom",
      voyage: false,
      model: "text-embedding-3-small",
    });
    expect(
      embeddingEndpoint("voyage-4", {
        EMBEDDING_API_URL: "https://api.voyageai.com/v1/embeddings/",
        EMBEDDING_API_KEY: "custom",
      }),
    ).toEqual({ url: "https://api.voyageai.com/v1/embeddings", key: "custom", voyage: true, model: "voyage-4" });
    expect(embeddingEndpoint("voyage-4", { EMBEDDING_API_URL: "not a url", EMBEDDING_API_KEY: "custom" })).toEqual({
      url: "not a url/embeddings",
      key: "custom",
      voyage: false,
      model: "voyage-4",
    });
    expect(
      embeddingEndpoint("voyage-4", {
        EMBEDDING_API_URL: "https://embed.test/v1",
        EMBEDDING_KEY: "user",
        OPENROUTER_API_KEY: "or",
      }),
    ).toEqual({ url: "https://embed.test/v1/embeddings", key: "user", voyage: false, model: "voyage-4" });
    expect(
      embeddingEndpoint("text-embedding-3-small", {
        EMBEDDING_API_URL: "https://embed.test/v1",
        OPENROUTER_API_KEY: "or",
      }),
    ).toEqual({ url: "https://embed.test/v1/embeddings", key: "or", voyage: false, model: "text-embedding-3-small" });
    expect(
      embeddingEndpoint("voyage-4", { EMBEDDING_KEY: "  ", EMBEDDING_SOURCE: "fireworks", VOYAGE_API_KEY: "v" }),
    ).toEqual({ url: VOYAGE_EMBEDDINGS_URL, key: "v", voyage: true, model: "voyage-4" });
    expect(embeddingEndpoint("voyage-4", { EMBEDDING_KEY: "fw", EMBEDDING_SOURCE: "fireworks" })).toEqual({
      url: FIREWORKS_EMBEDDINGS_URL,
      key: "fw",
      voyage: false,
      model: "voyageai/voyage-4",
    });
    expect(embeddingEndpoint("voyage-4-lite", { EMBEDDING_KEY: "gw", EMBEDDING_SOURCE: "gateway" })).toEqual({
      url: GATEWAY_EMBEDDINGS_URL,
      key: "gw",
      voyage: false,
      model: "voyageai/voyage-4-lite",
    });
    expect(embeddingEndpoint("voyage-4", { EMBEDDING_KEY: "k", EMBEDDING_SOURCE: "other" })).toEqual({
      url: OPENROUTER_EMBEDDINGS_URL,
      key: "k",
      voyage: false,
      model: "voyageai/voyage-4",
    });
    expect(
      embeddingEndpoint("openai/text-embedding-3-small", { EMBEDDING_KEY: "fw", EMBEDDING_SOURCE: "fireworks" }),
    ).toEqual({
      url: FIREWORKS_EMBEDDINGS_URL,
      key: "fw",
      voyage: false,
      model: "openai/text-embedding-3-small",
    });

    const embedded = await embedTexts(["b", "a"], "voyage-4", fetchImpl, { VOYAGE_API_KEY: "test-key" });
    expect(embedded).toEqual({
      ok: true,
      vectors: [
        [1, 1],
        [2, 2],
      ],
    });
    expect(calls[0]).toEqual({
      url: VOYAGE_EMBEDDINGS_URL,
      body: JSON.stringify({ input: ["b", "a"], model: "voyage-4", input_type: "query" }),
      authorization: "Bearer test-key",
    });

    const custom = await embedTexts(["a"], "text-embedding-3-small", fetchImpl, {
      EMBEDDING_API_URL: "https://embed.test/v1",
      EMBEDDING_API_KEY: "custom",
    });
    expect(custom.ok).toBe(true);
    expect(JSON.parse(calls[1]?.body ?? "")).toEqual({ input: ["a"], model: "text-embedding-3-small" });
  });

  test("refuses a response that is not one vector per text", async () => {
    const mixed = await embedTexts(
      ["a", "b"],
      "voyage-4",
      async () => jsonResponse({ data: [{ embedding: [1] }, { embedding: [1, 2] }] }),
      { VOYAGE_API_KEY: "test-key" },
    );
    expect(mixed).toEqual({ ok: false, error: EMBED_LENGTH_ERROR });
    const answers: unknown[] = [
      { data: [null] },
      { data: [{ embedding: [] }] },
      { data: [{ embedding: [Number.NaN] }] },
      { data: [{ embedding: ["1"] }] },
      { data: [] },
      {},
      null,
    ];
    const expected = [
      EMBED_VECTOR_ERROR,
      EMBED_VECTOR_ERROR,
      EMBED_VECTOR_ERROR,
      EMBED_VECTOR_ERROR,
      EMBED_COUNT_ERROR,
      EMBED_UNREADABLE_ERROR,
      EMBED_UNREADABLE_ERROR,
    ];
    const results = await Promise.all(
      answers.map((body) =>
        embedTexts(["a"], "voyage-4", async () => jsonResponse(body), {
          VOYAGE_API_KEY: "test-key",
        }),
      ),
    );
    results.forEach((result, index) => {
      expect(result).toEqual({ ok: false, error: expected[index] });
    });
    const refused = await embedTexts(["a"], "voyage-4", async () => new Response("no", { status: 401 }), {
      VOYAGE_API_KEY: "test-key",
    });
    expect(refused).toEqual({
      ok: false,
      error: "The embedding service refused the text (401). The query was not sent.",
    });
    const unreadable = await embedTexts(["a"], "voyage-4", async () => new Response("not-json", { status: 200 }), {
      VOYAGE_API_KEY: "test-key",
    });
    expect(unreadable).toEqual({ ok: false, error: EMBED_UNREADABLE_ERROR });
    const down = await embedTexts(
      ["a"],
      "voyage-4",
      () => {
        throw new Error("down");
      },
      { EMBEDDING_API_KEY: "fallback" },
    );
    expect(down).toEqual({ ok: false, error: EMBED_UNREACHABLE_ERROR });
  });
});

describe("embedding settings", () => {
  test("remembers a default and one model per connection", () => {
    const storage = installStorage();
    expect(readEmbeddingSettings()).toEqual(DEFAULT_EMBEDDING_SETTINGS);
    expect(embeddingModelFor(undefined)).toBe(DEFAULT_EMBEDDING_MODEL);
    expect(embeddingModelFor("  ")).toBe(DEFAULT_EMBEDDING_MODEL);
    writeEmbeddingModel(undefined, "voyage-4-lite");
    writeEmbeddingModel("orders", "text-embedding-3-small");
    writeEmbeddingModel("orders", "bad model");
    expect(embeddingModelFor("orders")).toBe(DEFAULT_EMBEDDING_MODEL);
    expect(embeddingModelFor("other")).toBe("voyage-4-lite");
    writeEmbeddingModel("orders", "text-embedding-3-small");
    writeEmbeddingModel("orders", "");
    expect(embeddingModelFor("orders")).toBe("voyage-4-lite");
    writeEmbeddingModel("orders", "");
    expect(storage.getItem("libredb_embedding")).not.toContain("orders");

    const seen: string[] = [];
    const stop = subscribeEmbeddingSettings(() => seen.push(embeddingModelFor(undefined)));
    writeEmbeddingModel(undefined, "voyage-code-4");
    stop();
    writeEmbeddingModel(undefined, "voyage-4");
    expect(seen).toEqual(["voyage-code-4"]);

    for (let index = 0; index <= 200; index += 1) writeEmbeddingModel(`c${index}`, "voyage-4-lite");
    const stored = readEmbeddingSettings();
    expect(stored.byConnection.c0).toBeUndefined();
    expect(stored.byConnection.c200).toBe("voyage-4-lite");
    expect(Object.keys(stored.byConnection)).toHaveLength(200);

    storage.setItem(
      "libredb_embedding",
      JSON.stringify({
        defaultModel: 4,
        byConnection: {
          ...Object.fromEntries(Array.from({ length: 201 }, (_, index) => [`n${index}`, "voyage-4"])),
          "": "voyage-4",
          ["k".repeat(201)]: "voyage-4",
          bad: "bad model",
          kept: "voyage-4-lite",
        },
      }),
    );
    const read = readEmbeddingSettings();
    expect(read.defaultModel).toBe(DEFAULT_EMBEDDING_MODEL);
    expect(read.byConnection.kept).toBe("voyage-4-lite");
    expect(read.byConnection.bad).toBeUndefined();
    expect(read.byConnection[""]).toBeUndefined();
    expect(read.byConnection["k".repeat(201)]).toBeUndefined();
    expect(read.byConnection.n0).toBeUndefined();
    expect(read.byConnection.n200).toBe("voyage-4");
    expect(readEmbeddingSettings()).toBe(read);

    storage.setItem("libredb_embedding", "not-json");
    expect(readEmbeddingSettings()).toEqual(DEFAULT_EMBEDDING_SETTINGS);
    storage.setItem("libredb_embedding", "null");
    expect(readEmbeddingSettings()).toEqual(DEFAULT_EMBEDDING_SETTINGS);
    storage.setItem("libredb_embedding", "[]");
    expect(readEmbeddingSettings()).toEqual(DEFAULT_EMBEDDING_SETTINGS);
    storage.setItem("libredb_embedding", JSON.stringify({ byConnection: [] }));
    expect(readEmbeddingSettings().byConnection).toEqual({});

    const throwing = new MemoryStorage();
    throwing.getItem = () => {
      throw new Error("locked");
    };
    setEmbeddingStorage(throwing);
    expect(readEmbeddingSettings()).toEqual(DEFAULT_EMBEDDING_SETTINGS);

    const full = installStorage();
    writeEmbeddingModel(undefined, "voyage-4-lite");
    full.setItem = () => {
      throw new Error("full");
    };
    writeEmbeddingModel(undefined, "voyage-code-4");
    expect(embeddingModelFor(undefined)).toBe("voyage-4-lite");

    setEmbeddingStorage(null);
    expect(readEmbeddingSettings()).toBe(DEFAULT_EMBEDDING_SETTINGS);
    writeEmbeddingModel("orders", "voyage-4-lite");
    expect(embeddingModelFor("orders")).toBe(DEFAULT_EMBEDDING_MODEL);
    setEmbeddingStorage(undefined);
    expect(readEmbeddingSettings()).toEqual(DEFAULT_EMBEDDING_SETTINGS);
  });
});
