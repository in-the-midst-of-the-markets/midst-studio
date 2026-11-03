import { afterEach, describe, expect, test } from "bun:test";
import { LLMAuthError, LLMError, LLMRateLimitError } from "@/lib/llm/types";
import {
  completeChat,
  FIREWORKS_CHAT_URL,
  GATEWAY_CHAT_URL,
  GATEWAY_MODELS_URL,
  listGatewayModels,
  listOpenRouterModels,
  OPENROUTER_CHAT_URL,
  OPENROUTER_MODELS_URL,
  resolveAssistKey,
} from "@/lib/ai/assist-transport";

const originalFetch = globalThis.fetch;
const originalKey = process.env.OPENROUTER_API_KEY;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = originalKey;
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const messages = [{ role: "user" as const, content: "Hi" }];

describe("resolveAssistKey", () => {
  test("prefers the key the browser sent", () => {
    process.env.OPENROUTER_API_KEY = "server";
    expect(resolveAssistKey("openrouter", "  browser  ")).toBe("browser");
    expect(resolveAssistKey("fireworks", "browser")).toBe("browser");
    expect(resolveAssistKey("gateway", "  browser  ")).toBe("browser");
  });

  test("uses the server OpenRouter key only when the browser sent none", () => {
    process.env.OPENROUTER_API_KEY = "  server  ";
    expect(resolveAssistKey("openrouter", "  ")).toBe("server");
    delete process.env.OPENROUTER_API_KEY;
    expect(resolveAssistKey("openrouter", "")).toBeNull();
    process.env.OPENROUTER_API_KEY = "   ";
    expect(resolveAssistKey("openrouter", "")).toBeNull();
    process.env.OPENROUTER_API_KEY = "server";
    expect(resolveAssistKey("fireworks", "")).toBeNull();
    expect(resolveAssistKey("gateway", "")).toBeNull();
  });
});

describe("completeChat", () => {
  test("posts to OpenRouter and reads a string answer", async () => {
    let seen: { url: string; headers: Headers; body: unknown } | undefined;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      seen = { url, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) };
      return jsonResponse({ choices: [{ message: { content: "  hello  " } }] });
    }) as unknown as typeof fetch;
    const text = await completeChat({ source: "openrouter", apiKey: "secret", model: "openai/gpt-4o", messages });
    expect(text).toBe("  hello  ");
    expect(seen?.url).toBe(OPENROUTER_CHAT_URL);
    expect(seen?.headers.get("Authorization")).toBe("Bearer secret");
    expect(seen?.headers.get("X-Title")).toBe("Midst");
    expect(seen?.body).toMatchObject({
      model: "openai/gpt-4o",
      stream: false,
      reasoning: { effort: "max" },
    });
    expect(seen?.body).not.toHaveProperty("max_tokens");
  });

  test("posts to Fireworks and joins text parts", async () => {
    let url = "";
    let body: unknown;
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      url = input;
      body = JSON.parse(String(init?.body));
      expect(new Headers(init?.headers).get("X-Title")).toBeNull();
      return jsonResponse({
        choices: [{ message: { content: ["a", { text: "b" }, { text: 1 }, 4] } }],
      });
    }) as unknown as typeof fetch;
    const text = await completeChat({
      source: "fireworks",
      apiKey: "fw",
      model: "accounts/acme/models/tuned",
      messages,
    });
    expect(url).toBe(FIREWORKS_CHAT_URL);
    expect(text).toBe("ab");
    expect(body).not.toHaveProperty("reasoning");
  });

  test("posts to Vercel AI Gateway without OpenRouter headers", async () => {
    let seen: { url: string; headers: Headers; body: unknown } | undefined;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      seen = { url, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) };
      return jsonResponse({ choices: [{ message: { content: "routed" } }] });
    }) as unknown as typeof fetch;
    const text = await completeChat({
      source: "gateway",
      apiKey: "gw",
      model: "alibaba/qwen-3-14b",
      messages,
    });
    expect(text).toBe("routed");
    expect(seen?.url).toBe(GATEWAY_CHAT_URL);
    expect(seen?.headers.get("Authorization")).toBe("Bearer gw");
    expect(seen?.headers.get("X-Title")).toBeNull();
    expect(seen?.body).toMatchObject({ model: "alibaba/qwen-3-14b", stream: false });
    expect(seen?.body).not.toHaveProperty("reasoning");
  });

  test.each([
    [401, LLMAuthError],
    [403, LLMAuthError],
    [429, LLMRateLimitError],
    [500, LLMError],
  ] as const)("status %s raises %s", async (status, ctor) => {
    globalThis.fetch = (async () => jsonResponse({ error: "no" }, status)) as unknown as typeof fetch;
    await expect(completeChat({ source: "openrouter", apiKey: "k", model: "m", messages })).rejects.toBeInstanceOf(
      ctor,
    );
  });

  test("rejects an empty answer and a body that is not a completion", async () => {
    const payloads = [
      null,
      {},
      { choices: [] },
      { choices: [null] },
      { choices: [{}] },
      { choices: [{ message: null }] },
      { choices: [{ message: {} }] },
      { choices: [{ message: { content: 1 } }] },
      { choices: [{ message: { content: "" } }] },
    ];
    for (const payload of payloads) {
      globalThis.fetch = (async () => jsonResponse(payload)) as unknown as typeof fetch;
      await expect(completeChat({ source: "openrouter", apiKey: "k", model: "m", messages })).rejects.toThrow(
        "empty answer",
      );
    }
  });

  test("reads a blank content from the reasoning fields, and keeps a real answer", async () => {
    const read = async (payload: unknown): Promise<string> => {
      globalThis.fetch = (async () => jsonResponse(payload)) as unknown as typeof fetch;
      return completeChat({ source: "openrouter", apiKey: "k", model: "m", messages });
    };
    expect(await read({ choices: [{ message: { content: "", reasoning: "  from reasoning  " } }] })).toBe(
      "  from reasoning  ",
    );
    expect(
      await read({
        choices: [
          { message: { content: "   ", reasoning: "   ", reasoning_content: [{ text: "from field" }, " tail"] } },
        ],
      }),
    ).toBe("from field tail");
    expect(
      await read({
        choices: [
          {
            message: {
              reasoning_content: "",
              reasoning_details: ["detail ", { text: "text" }, { text: 2 }, null],
            },
          },
        ],
      }),
    ).toBe("detail text");
    expect(await read({ choices: [{ message: { content: "visible", reasoning: "hidden" } }] })).toBe("visible");
  });

  test("treats a body that is not JSON as an empty answer", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 200 })) as unknown as typeof fetch;
    await expect(completeChat({ source: "openrouter", apiKey: "k", model: "m", messages })).rejects.toThrow(
      "empty answer",
    );
  });
});

describe("listOpenRouterModels", () => {
  test("sorts, drops blanks and duplicates, and caps the list", async () => {
    const data = [
      { id: "b/two", name: "Beta" },
      { id: "a/one" },
      { id: "  ", name: "Blank" },
      { id: "b/two", name: "Again" },
      null,
      { name: "No id" },
      { id: 4 },
      ...Array.from({ length: 400 }, (_, index) => ({ id: `m/${index}`, name: `M ${String(index).padStart(3, "0")}` })),
    ];
    let url = "";
    globalThis.fetch = (async (input: string) => {
      url = input;
      return jsonResponse({ data });
    }) as unknown as typeof fetch;
    const models = await listOpenRouterModels();
    expect(url).toBe(OPENROUTER_MODELS_URL);
    expect(models).toHaveLength(400);
    expect(models[0]?.name.localeCompare(models[1]?.name ?? "") ?? 0).toBeLessThanOrEqual(0);
    expect(models.some((item) => item.id === "a/one" && item.name === "a/one")).toBe(true);
  });

  test("returns nothing when the catalog is not a list", async () => {
    globalThis.fetch = (async () => jsonResponse({ data: "no" })) as unknown as typeof fetch;
    expect(await listOpenRouterModels()).toEqual([]);
    globalThis.fetch = (async () => new Response("nope", { status: 200 })) as unknown as typeof fetch;
    expect(await listOpenRouterModels()).toEqual([]);
    globalThis.fetch = (async () => jsonResponse(null)) as unknown as typeof fetch;
    expect(await listOpenRouterModels()).toEqual([]);
  });

  test("raises when the catalog cannot be read", async () => {
    globalThis.fetch = (async () => jsonResponse({}, 503)) as unknown as typeof fetch;
    await expect(listOpenRouterModels()).rejects.toThrow("could not be read");
  });
});

describe("listGatewayModels", () => {
  test("reads the public gateway catalog", async () => {
    let url = "";
    globalThis.fetch = (async (input: string) => {
      url = input;
      return jsonResponse({ data: [{ id: "alibaba/qwen-3-14b", name: "Qwen3-14B" }] });
    }) as unknown as typeof fetch;
    expect(await listGatewayModels()).toEqual([{ id: "alibaba/qwen-3-14b", name: "Qwen3-14B" }]);
    expect(url).toBe(GATEWAY_MODELS_URL);
  });

  test("raises when the gateway catalog cannot be read", async () => {
    globalThis.fetch = (async () => jsonResponse({}, 503)) as unknown as typeof fetch;
    await expect(listGatewayModels()).rejects.toThrow("Vercel AI Gateway model list");
  });
});
