import "../../setup-dom";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { editorChatQuery, IdeQueryChat } from "@/components/ai-assist/IdeQueryChat";
import { BOARD_CONTEXT_CAP } from "@/lib/ai/dashboard-prompt";
import { writeAssistSettings } from "@/lib/ai/assist-settings";

const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(body === undefined ? "nope" : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const calls: { url: string; method: string; body: unknown }[] = [];

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  localStorage.removeItem("libredb_ai_assist");
  calls.length = 0;
});

function install(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    let body: unknown = null;
    if (init?.body !== undefined) body = JSON.parse(String(init.body));
    if (method === "POST") calls.push({ url, method, body });
    return handler(url, init);
  }) as unknown as typeof fetch;
}

describe("editorChatQuery", () => {
  test("writes a built statement into a query tab and leaves a source tab alone", () => {
    const update = mock(() => {});
    const bound = editorChatQuery({ id: "tab-1", query: "SELECT 1" }, update);
    expect(bound.sql).toBe("SELECT 1");
    bound.onUseQuery?.("SELECT 2");
    expect(update).toHaveBeenCalledWith("tab-1", { query: "SELECT 2" });
    expect(editorChatQuery({ id: "tab-1", query: "SELECT 1", source: { path: ["app"] } }, update)).toEqual({
      sql: "",
    });
  });
});

describe("IdeQueryChat", () => {
  test("builds a query, renders markdown, and puts the statement in the editor", async () => {
    const schema = `a\n${"b".repeat(30_000)}`;
    install((url, init) => {
      if ((init?.method ?? "GET") === "GET") {
        return jsonResponse({
          models: [{ id: "other/model", name: "Other" }],
          gatewayModels: [{ id: "alibaba/qwen-3-14b", name: "Qwen" }],
          gatewayCatalog: true,
        });
      }
      return jsonResponse({
        explanation: "**Revenue** is `120`.\n\n- East led.",
        queries: [{ title: "Query", sql: "SELECT 1", chart: null }],
      });
    });
    const onUseQuery = mock(() => {});
    const view = render(
      <IdeQueryChat sql="SELECT 1" databaseType="postgres" schemaContext={schema} onUseQuery={onUseQuery} />,
    );
    const ask = view.getByRole("button", { name: "Ask AI" });
    expect(ask.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(ask);
    expect(ask.getAttribute("aria-expanded")).toBe("true");
    const box = view.getByLabelText("Build or revise a query");
    expect(box.getAttribute("placeholder")).toBe("Tell me what query to build or optimize");
    expect(view.getByText("Shift + Enter for a new line")).toBeTruthy();
    expect(view.getByText("AI can make mistakes. Review generated queries.")).toBeTruthy();
    expect(view.getByRole("button", { name: "Model configuration" }).getAttribute("aria-expanded")).toBe("false");
    expect((view.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(box, { target: { value: "Count rows" } });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(calls).toHaveLength(0);
    fireEvent.keyDown(box, { key: "Enter" });
    expect(await view.findByText("Revenue")).toBeTruthy();
    expect(view.container.querySelector("strong")?.textContent).toBe("Revenue");
    expect(view.container.querySelector("code")?.textContent).toBe("120");
    expect(view.container.querySelector("li")?.textContent).toBe("East led.");
    fireEvent.click(view.getByRole("button", { name: "Use this query" }));
    expect(onUseQuery).toHaveBeenCalledWith("SELECT 1");
    const sent = calls[0]?.body as {
      schemaContext: string;
      editorSql: string;
      databaseType: string;
      history: unknown[];
    };
    expect(sent.editorSql).toBe("SELECT 1");
    expect(sent.databaseType).toBe("postgres");
    expect(sent.schemaContext).toBe(`a ${"b".repeat(29_998)}`);
    expect(sent.history).toEqual([]);

    fireEvent.click(view.getByRole("button", { name: "Model configuration" }));
    expect(await view.findByRole("option", { name: "Other" })).toBeTruthy();
    fireEvent.change(view.getByLabelText("OpenRouter model"), { target: { value: "other/model" } });
    expect(JSON.parse(localStorage.getItem("libredb_ai_assist") ?? "{}").openRouterModel).toBe("other/model");
    fireEvent.click(view.getByRole("button", { name: "Close" }));
    expect(view.queryByLabelText("Build or revise a query")).toBeNull();
  });

  test("keeps the last model and reports a failure", async () => {
    let posts = 0;
    let release: ((response: Response) => void) | undefined;
    install((url, init) => {
      if ((init?.method ?? "GET") === "GET") return jsonResponse({ models: [] });
      posts += 1;
      if (posts === 1) {
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      }
      if (posts === 2) return jsonResponse(null, 400);
      if (posts === 3) return jsonResponse({}, 400);
      if (posts === 4) return jsonResponse({ error: "  " }, 400);
      if (posts === 5) return jsonResponse({ error: 4 }, 400);
      if (posts === 6) return new Response("not-json", { status: 500 });
      if (posts === 7) return jsonResponse({ error: " The model refused. " }, 400);
      if (posts === 8) throw new Error("offline");
      return jsonResponse({ explanation: "", queries: [{ title: "Query", sql: "SELECT 2", chart: null }] });
    });
    const view = render(<IdeQueryChat sql="" databaseType="" schemaContext="orders" onUseQuery={() => {}} />);
    fireEvent.click(view.getByRole("button", { name: "Ask AI" }));
    const box = view.getByLabelText("Build or revise a query");
    fireEvent.keyDown(box, { key: "Enter" });
    expect(posts).toBe(0);
    fireEvent.change(box, { target: { value: "First" } });
    fireEvent.click(view.getByRole("button", { name: "Send" }));
    expect(await view.findByRole("button", { name: "Sending…" })).toBeTruthy();
    fireEvent.change(box, { target: { value: "still waiting" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(posts).toBe(1);
    release?.(jsonResponse({ explanation: "Done.", queries: [{ sql: "DELETE FROM orders" }] }));
    expect(await view.findByText("Done.")).toBeTruthy();
    expect(view.queryByRole("button", { name: "Use this query" })).toBeNull();

    const ask = async (text: string) => {
      const before = posts;
      fireEvent.change(view.getByLabelText("Build or revise a query"), { target: { value: text } });
      fireEvent.click(view.getByRole("button", { name: "Send" }));
      await waitFor(() => expect(posts).toBe(before + 1));
      await waitFor(() => expect(view.queryByRole("button", { name: "Sending…" })).toBeNull());
    };
    await ask("Second");
    await ask("Third");
    await ask("Fourth");
    await ask("Fifth");
    await ask("Sixth");
    expect(view.getAllByText("The assistant could not answer.")).toHaveLength(5);
    await ask("Seventh");
    expect(view.getByText("The model refused.")).toBeTruthy();
    await ask("Eighth");
    expect(view.getByText("The assistant could not be reached.")).toBeTruthy();
    await ask("<b>not bold</b>");
    expect(view.container.querySelector("b")).toBeNull();
    expect(view.container.textContent).toContain("<b>not bold</b>");
    expect(view.getByText("<b>not bold</b>").tagName).toBe("P");

    const history = (calls.at(-1)?.body as { history?: { question: string }[] } | undefined)?.history ?? [];
    expect(history).toHaveLength(5);
    expect(history[0]?.question).toBe("Fourth");
  });

  test("asks for a model name and loads each catalog", async () => {
    localStorage.setItem(
      "libredb_ai_assist",
      JSON.stringify({
        source: "fireworks",
        openRouterModel: "deepseek/deepseek-v4.1-flash-1017",
        fireworksModel: "",
        gatewayModel: "alibaba/qwen-3-14b",
        openRouterKey: "",
        fireworksKey: "fw-secret",
        gatewayKey: "gw-secret",
      }),
    );
    let gets = 0;
    install(() => {
      gets += 1;
      if (gets === 1) return jsonResponse({});
      if (gets === 2) return jsonResponse(null);
      if (gets === 3) return jsonResponse({}, 503);
      throw new Error("offline");
    });
    const view = render(<IdeQueryChat sql="SELECT 1" databaseType="postgres" schemaContext="orders" />);
    fireEvent.click(view.getByRole("button", { name: "Ask AI" }));
    fireEvent.change(view.getByLabelText("Build or revise a query"), { target: { value: "Count" } });
    fireEvent.keyDown(view.getByLabelText("Build or revise a query"), { key: "Enter" });
    expect(await view.findByRole("alert")).toHaveProperty("textContent", "Name the model to use.");
    expect(calls).toHaveLength(0);

    writeAssistSettings({
      source: "openrouter",
      openRouterModel: "deepseek/deepseek-v4.1-flash-1017",
      fireworksModel: "",
      gatewayModel: "alibaba/qwen-3-14b",
      openRouterKey: "",
      fireworksKey: "fw-secret",
      gatewayKey: "gw-secret",
      historyMessages: 5,
    });
    fireEvent.click(view.getByRole("button", { name: "Model configuration" }));
    expect(await view.findByRole("option", { name: "DeepSeek V4.1 Flash" })).toBeTruthy();
    expect(view.queryByText("The OpenRouter catalog could not be loaded.")).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Model configuration" }));
    fireEvent.click(view.getByRole("button", { name: "Model configuration" }));
    await waitFor(() => expect(gets).toBe(2));
    expect(view.queryByText("The OpenRouter catalog could not be loaded.")).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Model configuration" }));
    fireEvent.click(view.getByRole("button", { name: "Model configuration" }));
    expect(await view.findByText("The OpenRouter catalog could not be loaded.")).toBeTruthy();
    writeAssistSettings({
      source: "gateway",
      openRouterModel: "deepseek/deepseek-v4.1-flash-1017",
      fireworksModel: "",
      gatewayModel: "alibaba/qwen-3-14b",
      openRouterKey: "",
      fireworksKey: "fw-secret",
      gatewayKey: "gw-secret",
      historyMessages: 5,
    });
    expect(await view.findByText("The Vercel AI Gateway catalog could not be loaded.")).toBeTruthy();
    const before = gets;
    fireEvent.click(view.getByRole("button", { name: "Model configuration" }));
    expect(gets).toBe(before);
    fireEvent.click(view.getByRole("button", { name: "Model configuration" }));
    await waitFor(() => expect(gets).toBe(before + 1));
    expect(view.getByText("The Vercel AI Gateway catalog could not be loaded.")).toBeTruthy();

    fireEvent.change(view.getByLabelText("Vercel AI Gateway model"), { target: { value: "alibaba/qwen-plus" } });
    install((_url, init) => {
      if ((init?.method ?? "GET") === "GET") {
        return jsonResponse({
          gatewayModels: [{ id: "alibaba/qwen-3-14b", name: "Qwen" }],
          gatewayCatalog: false,
        });
      }
      return jsonResponse({ explanation: "Routed.", queries: [] });
    });
    fireEvent.click(view.getByRole("button", { name: "Model configuration" }));
    fireEvent.click(view.getByRole("button", { name: "Model configuration" }));
    expect(await view.findByText("The Vercel AI Gateway catalog could not be loaded.")).toBeTruthy();
    const listed = document.querySelector("#vercel-gateway-models option");
    expect(listed?.getAttribute("value")).toBe("alibaba/qwen-3-14b");
    fireEvent.change(view.getByLabelText("Build or revise a query"), { target: { value: "Cost" } });
    fireEvent.click(view.getByRole("button", { name: "Send" }));
    expect(await view.findByText("Routed.")).toBeTruthy();
    expect(calls.at(-1)?.body).toMatchObject({ source: "gateway", model: "alibaba/qwen-plus", apiKey: "gw-secret" });

    writeAssistSettings({
      source: "fireworks",
      openRouterModel: "deepseek/deepseek-v4.1-flash-1017",
      fireworksModel: "accounts/acme/models/tuned",
      gatewayModel: "",
      openRouterKey: "",
      fireworksKey: "fw-secret",
      gatewayKey: "",
      historyMessages: 5,
    });
    fireEvent.change(await view.findByLabelText("Fireworks model"), {
      target: { value: "accounts/acme/models/other" },
    });
    fireEvent.change(view.getByLabelText("Build or revise a query"), { target: { value: "Again" } });
    fireEvent.click(view.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(view.getAllByText("Routed.")).toHaveLength(2));
    expect(calls.at(-1)?.body).toMatchObject({
      source: "fireworks",
      model: "accounts/acme/models/other",
      apiKey: "fw-secret",
    });
    expect(view.queryByRole("button", { name: "Use this query" })).toBeNull();
    view.unmount();
    const again = render(<IdeQueryChat sql="" databaseType="" schemaContext="" />);
    fireEvent.click(again.getByRole("button", { name: "Ask AI" }));
    fireEvent.click(again.getByRole("button", { name: "Model configuration" }));
    expect((again.getByLabelText("Fireworks model") as HTMLInputElement).value).toBe("accounts/acme/models/other");
  });

  test("leaves HTML as text when the answer has no statement", async () => {
    install((_url, init) => {
      if ((init?.method ?? "GET") === "GET") return jsonResponse({});
      return jsonResponse({ explanation: '<img src="x" onerror="alert(1)">', queries: [] });
    });
    const view = render(
      <IdeQueryChat sql="SELECT 1" databaseType="postgres" schemaContext="orders" onUseQuery={() => {}} />,
    );
    fireEvent.click(view.getByRole("button", { name: "Ask AI" }));
    fireEvent.change(view.getByLabelText("Build or revise a query"), { target: { value: "Show" } });
    fireEvent.click(view.getByRole("button", { name: "Send" }));
    expect(await view.findByText(/<img/)).toBeTruthy();
    expect(view.container.querySelector("img")).toBeNull();
    expect(view.queryByRole("button", { name: "Use this query" })).toBeNull();
  });

  test("clears the conversation, and drops it when the connection changes", async () => {
    let release: ((response: Response) => void) | undefined;
    install((_url, init) => {
      if ((init?.method ?? "GET") === "GET") return jsonResponse({});
      const body = JSON.parse(String(init?.body)) as { question?: string };
      if (body.question === "Hold") {
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      }
      if (body.question === "Count") {
        return jsonResponse({ explanation: "Ten rows.", queries: [{ sql: "SELECT 1" }] });
      }
      return jsonResponse({
        explanation: "Nodes named Ada.",
        queries: [{ title: "Ada", sql: "MATCH (n) WHERE n.name = 'Ada' RETURN n LIMIT 5", connection: "Graph" }],
      });
    });
    const onUseQuery = mock(() => {});
    const view = render(
      <IdeQueryChat sql="" connectionId="pg" databaseType="postgres" schemaContext="orders" onUseQuery={onUseQuery} />,
    );
    fireEvent.click(view.getByRole("button", { name: "Ask AI" }));
    fireEvent.change(view.getByLabelText("Build or revise a query"), { target: { value: "Count" } });
    fireEvent.click(view.getByRole("button", { name: "Send" }));
    expect(await view.findByText("Ten rows.")).toBeTruthy();

    view.rerender(
      <IdeQueryChat sql="" connectionId="graph" databaseType="neo4j" schemaContext="labels" onUseQuery={onUseQuery} />,
    );
    expect(view.queryByText("Count")).toBeNull();
    expect(view.queryByText("Ten rows.")).toBeNull();
    fireEvent.change(view.getByLabelText("Build or revise a query"), { target: { value: "People named Ada" } });
    fireEvent.click(view.getByRole("button", { name: "Send" }));
    expect(await view.findByText("Nodes named Ada.")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Use this query" }));
    expect(onUseQuery).toHaveBeenCalledWith("MATCH (n) WHERE n.name = 'Ada' RETURN n LIMIT 5");
    const sent = calls.at(-1)?.body as { history?: unknown[]; databaseType?: string } | undefined;
    expect(sent?.history).toEqual([]);
    expect(sent?.databaseType).toBe("neo4j");

    fireEvent.click(view.getByRole("button", { name: "Clear chat" }));
    expect(view.getByRole("button", { name: "Clear chat" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(view.getByRole("button", { name: "Clear chat" }));
    expect(view.queryByRole("button", { name: "Confirm clear chat" })).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Clear chat" }));
    fireEvent.click(view.getByRole("button", { name: "Confirm clear chat" }));
    expect(view.queryByText("Nodes named Ada.")).toBeNull();
    expect(view.queryByRole("button", { name: "Clear chat" })).toBeNull();

    fireEvent.change(view.getByLabelText("Build or revise a query"), { target: { value: "Hold" } });
    fireEvent.click(view.getByRole("button", { name: "Send" }));
    expect(await view.findByText("Hold")).toBeTruthy();
    view.rerender(
      <IdeQueryChat sql="" connectionId="other" databaseType="neo4j" schemaContext="labels" onUseQuery={onUseQuery} />,
    );
    expect(view.queryByText("Hold")).toBeNull();
    release?.(
      jsonResponse({
        explanation: "This answer belongs to the previous connection.",
        queries: [{ sql: "MATCH (n) RETURN n" }],
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(view.queryByText("This answer belongs to the previous connection.")).toBeNull();
    expect(view.queryByRole("button", { name: "Sending…" })).toBeNull();
  });

  test("can pin the chat and keep the reply as text", async () => {
    install(() =>
      jsonResponse({
        explanation: "East led.",
        queries: [{ title: "Query", sql: "SELECT 1", chart: null }],
      }),
    );
    const onUseQuery = mock(() => {});
    const onUseNote = mock(() => {});
    const view = render(
      <IdeQueryChat
        sql=""
        databaseType="postgres"
        schemaContext="[]"
        placement="fixed"
        conversationLabel="Dashboard conversation"
        useQueryLabel="Add as chart"
        noteLabel="Add as text"
        onUseQuery={onUseQuery}
        onUseNote={onUseNote}
      />,
    );
    const ask = view.getByRole("button", { name: "Ask AI" });
    expect(ask.className).toContain("fixed");
    fireEvent.click(ask);
    expect(view.getByLabelText("Dashboard conversation")).toBeTruthy();
    fireEvent.change(view.getByLabelText("Build or revise a query"), { target: { value: "Revenue" } });
    fireEvent.click(view.getByRole("button", { name: "Send" }));
    fireEvent.click(await view.findByRole("button", { name: "Add as chart" }));
    fireEvent.click(view.getByRole("button", { name: "Add as text" }));
    expect(onUseQuery).toHaveBeenCalledWith("SELECT 1");
    expect(onUseNote).toHaveBeenCalledWith("East led.");
  });

  test("places a dashboard reply without an add button", async () => {
    install(() =>
      jsonResponse({
        explanation: "East led.",
        queries: [{ title: "Query", sql: "SELECT 1", chart: null }],
      }),
    );
    const onPlaceReply = mock(() => {});
    const view = render(
      <IdeQueryChat
        sql=""
        databaseType="postgres"
        schemaContext="[]"
        placement="fixed"
        conversationLabel="Dashboard conversation"
        onPlaceReply={onPlaceReply}
        onUseQuery={() => {}}
        onUseNote={() => {}}
      />,
    );
    fireEvent.click(view.getByRole("button", { name: "Ask AI" }));
    fireEvent.change(view.getByLabelText("Build or revise a query"), { target: { value: "Revenue" } });
    fireEvent.click(view.getByRole("button", { name: "Send" }));
    expect(await view.findByText("East led.")).toBeTruthy();
    expect(onPlaceReply).toHaveBeenCalledWith({ sql: "SELECT 1", text: "East led." });
    expect(view.queryByRole("button", { name: "Add as chart" })).toBeNull();
    expect(view.queryByRole("button", { name: "Add as text" })).toBeNull();
    expect(view.queryByRole("button", { name: "Use this query" })).toBeNull();
  });

  test("sends the dashboard inventory instead of the editor statement", async () => {
    install(() => jsonResponse({ explanation: "Noted.", queries: [] }));
    const board = `Cells:\n${"x".repeat(BOARD_CONTEXT_CAP)}`;
    const view = render(
      <IdeQueryChat
        sql="SELECT 1"
        databaseType="postgres"
        schemaContext="[]"
        boardContext={board}
        promptLabel="Ask about this dashboard"
        promptPlaceholder="Ask a question about this dashboard"
        onPlaceReply={() => {}}
      />,
    );
    fireEvent.click(view.getByRole("button", { name: "Ask AI" }));
    const box = view.getByLabelText("Ask about this dashboard");
    expect(box.getAttribute("placeholder")).toBe("Ask a question about this dashboard");
    fireEvent.change(box, { target: { value: "What changed" } });
    fireEvent.click(view.getByRole("button", { name: "Send" }));
    expect(await view.findByText("Noted.")).toBeTruthy();
    const sent = calls[0]?.body as { editorSql?: string; boardContext?: string };
    expect(sent.editorSql).toBeUndefined();
    expect(sent.boardContext).toHaveLength(BOARD_CONTEXT_CAP);
    expect(sent.boardContext?.startsWith("Cells:")).toBe(true);
  });
});
