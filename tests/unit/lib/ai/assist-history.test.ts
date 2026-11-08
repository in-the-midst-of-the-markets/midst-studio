import { describe, expect, test } from "bun:test";
import {
  ASSIST_CONVERSATION_CAP,
  ASSIST_CONVERSATIONS_KEY,
  ASSIST_RETENTION_MS,
  ASSIST_TRANSCRIPT_KEY,
  createAssistConversation,
  readAssistConversations,
  readAssistTranscript,
  removeAssistConversation,
  renameAssistConversation,
  selectAssistConversation,
  touchAssistConversation,
  writeAssistConversations,
  writeAssistTranscript,
  type AssistConversation,
  type AssistConversationBook,
  type AssistTranscriptTurn,
} from "@/lib/ai/assist-history";

const now = Date.parse("2026-11-01T12:00:00.000Z");
const recent = new Date(now - 60_000).toISOString();
const stale = new Date(now - ASSIST_RETENTION_MS - 1_000).toISOString();

function storeOf(initial = ""): {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  saved(): string | null;
} {
  let raw = initial === "" ? null : initial;
  return {
    getItem: (key) => (key === ASSIST_TRANSCRIPT_KEY ? raw : null),
    setItem: (key, value) => {
      if (key === ASSIST_TRANSCRIPT_KEY) raw = value;
    },
    saved: () => raw,
  };
}

function turn(id: string, at: string, text = "Hello"): AssistTranscriptTurn {
  return { id, role: "user", text, at, cards: [] };
}

describe("readAssistTranscript", () => {
  test("reads nothing when the saved value is missing or not a list of turns", () => {
    expect(readAssistTranscript(now, storeOf())).toEqual([]);
    expect(readAssistTranscript(now, { getItem: () => "", setItem: () => {} })).toEqual([]);
    expect(readAssistTranscript(now, storeOf("not json"))).toEqual([]);
    expect(readAssistTranscript(now, storeOf("null"))).toEqual([]);
    expect(readAssistTranscript(now, storeOf("{}"))).toEqual([]);
  });

  test("keeps a turn from the last seven days and the chart it drew", () => {
    const fields = ["month", "", 4, ...Array.from({ length: 40 }, (_, index) => `c${index}`)];
    const row = { month: "Jan", revenue: 1 };
    const rows = [null, row, "nope", ...Array.from({ length: 200 }, () => ({ month: "Feb" }))];
    const raw = [
      null,
      { id: "", role: "user", text: "blank", at: recent, cards: [] },
      { id: "assist-1", role: "system", text: "nope", at: recent },
      { id: "assist-2", role: "user", text: "undated", at: "", cards: [] },
      { id: "assist-3", role: "user", text: "bad date", at: "yesterday", cards: [] },
      { id: "assist-4", role: "user", text: "old", at: stale, cards: [] },
      { id: "assist-5", role: "user", text: "no cards", at: recent },
      {
        id: "assist-6",
        role: "assistant",
        text: "kept",
        at: recent,
        cards: [
          null,
          { id: "", sql: "SELECT 1" },
          { id: "drop", sql: "" },
          {
            id: "card-1",
            sql: "SELECT 1",
            locked: true,
            connectionId: "c1",
            color: " blue ",
            error: "denied",
            chart: { type: "bar", x: " month ", y: [" revenue ", "cost"], caption: "by month", color: "red" },
            result: {
              fields: ["month", "", 4, "revenue"],
              rows: [null, { month: "Jan" }, "nope"],
              rowCount: 9,
              executionTime: 3,
            },
          },
          {
            id: "card-2",
            sql: "SELECT 2",
            chart: { type: "pie", x: "month", y: ["revenue"] },
            result: { fields: [], rows: [] },
          },
          { id: "card-3", sql: "SELECT 3", chart: null, result: { fields: "month", rows: [] } },
          { id: "card-4", sql: "SELECT 4", chart: 4, result: [] },
          {
            id: "card-5",
            sql: "SELECT 5",
            chart: { type: "line", x: " ", y: ["revenue"] },
            result: { fields: [""], rows: [] },
          },
          {
            id: "card-6",
            sql: "SELECT 6",
            color: "rainbow",
            connectionId: 4,
            locked: "yes",
            error: 4,
            chart: {
              type: "line",
              x: "month",
              y: ["revenue", "cost", "tax", "fee", "extra"],
              caption: 4,
              color: "teal",
            },
            result: { fields, rows },
          },
          { id: "card-y", sql: "SELECT 8", chart: { type: "bar", x: "month", y: [""] } },
        ],
      },
    ];
    const kept = readAssistTranscript(now, storeOf(JSON.stringify(raw)));
    expect(kept.map((item) => item.id)).toEqual(["assist-5", "assist-6"]);
    expect(kept[0]?.cards).toEqual([]);
    const cards = kept[1]?.cards ?? [];
    expect(cards.map((card) => card.id)).toEqual([
      "card-1",
      "card-2",
      "card-3",
      "card-4",
      "card-5",
      "card-6",
      "card-y",
    ]);
    expect(cards[0]).toMatchObject({
      title: "Query",
      titledSql: "SELECT 1",
      modelSql: "SELECT 1",
      locked: true,
      connectionId: "c1",
      connectionName: "",
      color: "#3987e5",
      error: "denied",
      chart: { type: "bar", x: "month", y: ["revenue", "cost"], caption: "by month", color: "#e66767" },
      result: { fields: ["month", "revenue"], rows: [{ month: "Jan" }], rowCount: 9, executionTime: 3 },
    });
    expect(cards[1]?.chart).toBeNull();
    expect(cards[1]?.result).toBeNull();
    expect(cards[2]?.chart).toBeNull();
    expect(cards[2]?.result).toBeNull();
    expect(cards[3]?.chart).toBeNull();
    expect(cards[4]?.chart).toBeNull();
    expect(cards[6]?.chart).toBeNull();
    expect(cards[5]).toMatchObject({
      color: "#199e70",
      connectionId: null,
      locked: false,
      error: null,
      chart: { type: "line", x: "month", y: ["revenue", "cost", "tax", "fee"], caption: "", color: "#199e70" },
    });
    expect(cards[5]?.result?.fields).toHaveLength(40);
    expect(cards[5]?.result?.rows).toHaveLength(200);
    expect(cards[5]?.result?.rowCount).toBe(200);
    expect(cards[5]?.result?.executionTime).toBe(0);
  });
});

describe("writeAssistTranscript", () => {
  test("writes the turns still inside the week and reads them back from this browser", () => {
    const fields = Array.from({ length: 41 }, (_, index) => `c${index}`);
    const rows = Array.from({ length: 201 }, (_, index) => ({ c0: index }));
    const saved: AssistTranscriptTurn = {
      id: "assist-1",
      role: "assistant",
      text: "Revenue rose.",
      at: recent,
      cards: [
        {
          id: "card-1",
          title: "Revenue",
          titledSql: "SELECT 1",
          modelSql: "SELECT 1",
          locked: false,
          sql: "SELECT 1",
          connectionId: null,
          connectionName: "Orders",
          chart: null,
          color: null,
          result: { fields, rows, rowCount: 201, executionTime: 8 },
          error: null,
          view: { typeId: "line", variationId: "area", selection: { category: ["month"], values: ["revenue"] } },
          code: '{ "title": { "text": "Edited" } }',
        },
      ],
    };
    writeAssistTranscript([turn("old", stale, "gone"), saved], now);
    const read = readAssistTranscript(now);
    expect(read).toHaveLength(1);
    expect(read[0]?.text).toBe("Revenue rose.");
    expect(read[0]?.cards[0]?.result?.rows).toHaveLength(200);
    expect(read[0]?.cards[0]?.result?.fields).toHaveLength(40);
    expect(read[0]?.cards[0]?.result?.rowCount).toBe(201);
    expect(read[0]?.cards[0]?.view).toEqual({
      typeId: "line",
      variationId: "area",
      selection: { category: ["month"], values: ["revenue"] },
    });
    expect(read[0]?.cards[0]?.code).toBe('{ "title": { "text": "Edited" } }');
  });

  test("keeps a chart type and its code, and drops a type or code it cannot trust", () => {
    const raw = {
      id: "assist-1",
      role: "assistant",
      text: "kept",
      at: recent,
      cards: [
        {
          id: "good",
          sql: "SELECT 1",
          view: { typeId: "line", variationId: "area", selection: { category: ["month"], values: ["revenue"] } },
          code: '{ "title": { "text": "Edited" } }',
        },
        {
          id: "empty-selection",
          sql: "SELECT 2",
          view: { typeId: "bar", variationId: "basic", selection: {} },
          code: "",
        },
        { id: "bad-type", sql: "SELECT 3", view: { typeId: "missing", variationId: "basic", selection: {} } },
        { id: "bad-selection", sql: "SELECT 4", view: { typeId: "line", variationId: "basic", selection: [] } },
        {
          id: "bad-column",
          sql: "SELECT 5",
          view: { typeId: "line", variationId: "basic", selection: { category: ["month", 4] } },
          code: "x".repeat(100_001),
        },
        { id: "no-view", sql: "SELECT 6", view: "pie", code: 4 },
      ],
    };
    const cards = readAssistTranscript(now, storeOf(JSON.stringify([raw])))[0]?.cards ?? [];
    expect(cards.map((card) => card.id)).toEqual([
      "good",
      "empty-selection",
      "bad-type",
      "bad-selection",
      "bad-column",
      "no-view",
    ]);
    expect(cards[0]?.view).toEqual({
      typeId: "line",
      variationId: "area",
      selection: { category: ["month"], values: ["revenue"] },
    });
    expect(cards[0]?.code).toContain("Edited");
    expect(cards[1]?.view).toEqual({ typeId: "bar", variationId: "basic", selection: {} });
    expect(cards[1]?.code).toBeNull();
    expect(cards[2]?.view).toBeNull();
    expect(cards[3]?.view).toBeNull();
    expect(cards[4]?.view).toBeNull();
    expect(cards[4]?.code).toBeNull();
    expect(cards[5]?.view).toBeNull();
    expect(cards[5]?.code).toBeNull();
  });

  test("drops the oldest turns until the saved copy fits, including one turn that is too big on its own", () => {
    const memory = storeOf();
    const huge = turn("huge", recent, "x".repeat(1_600_000));
    const small = turn("small", new Date(now).toISOString(), "hi");
    writeAssistTranscript([huge, small], now, memory);
    expect(JSON.parse(memory.saved() ?? "[]")).toEqual([small]);

    const only = storeOf();
    writeAssistTranscript([huge], now, only);
    expect(only.saved()).toBe("[]");
  });

  test("drops the oldest turns when the browser refuses the write", () => {
    const turns = [turn("a", recent, "one"), turn("b", recent, "two"), turn("c", recent, "three")];
    let attempts = 0;
    let saved = "";
    const flaky = {
      getItem: () => null,
      setItem: (_key: string, value: string) => {
        attempts += 1;
        if (attempts < 3) throw new Error("quota");
        saved = value;
      },
    };
    writeAssistTranscript(turns, now, flaky);
    expect(JSON.parse(saved)).toEqual([turns[2]]);

    let throws = 0;
    const full = {
      getItem: () => null,
      setItem: () => {
        throws += 1;
        throw new Error("quota");
      },
    };
    writeAssistTranscript(turns, now, full);
    expect(throws).toBe(4);
  });
});

function bookStore(initial = ""): {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  saved(): string | null;
} {
  let raw = initial === "" ? null : initial;
  return {
    getItem: (key) => (key === ASSIST_CONVERSATIONS_KEY ? raw : null),
    setItem: (key, value) => {
      if (key === ASSIST_CONVERSATIONS_KEY) raw = value;
    },
    saved: () => raw,
  };
}

function conversation(
  id: string,
  name: string,
  updatedAt: string,
  turns: AssistTranscriptTurn[] = [],
): AssistConversation {
  return { id, name, updatedAt, turns };
}

function book(activeId: string, conversations: readonly AssistConversation[]): AssistConversationBook {
  return { activeId, conversations };
}

describe("assist conversations", () => {
  const older = new Date(now - 60_000).toISOString();
  const newest = new Date(now - 1_000).toISOString();

  test("starts from one empty conversation when nothing usable is saved", () => {
    expect(readAssistConversations(now, bookStore()).conversations).toEqual([
      { id: "conv-1", name: "New conversation", updatedAt: new Date(now).toISOString(), turns: [] },
    ]);
    expect(readAssistConversations(now, bookStore("not json")).activeId).toBe("conv-1");
    expect(readAssistConversations(now, bookStore("null")).activeId).toBe("conv-1");
    expect(readAssistConversations(now, bookStore("{}")).activeId).toBe("conv-1");
    expect(readAssistConversations(now, bookStore('{"conversations":[null,{"id":"bad id"}]}')).activeId).toBe("conv-1");
    expect(readAssistConversations(now, bookStore("[]")).activeId).toBe("conv-1");
    expect(
      readAssistConversations(
        now,
        bookStore(
          JSON.stringify({
            activeId: 4,
            conversations: [{ id: "bare", name: "Bare", updatedAt: recent, turns: "nope" }],
          }),
        ),
      ).conversations[0]?.turns,
    ).toEqual([]);
  });

  test("keeps a named conversation and drops a stale empty one", () => {
    const raw = {
      activeId: "missing",
      conversations: [
        null,
        { id: "conv-1", name: "  ", updatedAt: "yesterday" },
        { id: "dup", name: "First", updatedAt: older, turns: [turn("a", recent, "kept")] },
        { id: "dup", name: "Second", updatedAt: newest },
        { id: "old-empty", name: "Gone", updatedAt: stale, turns: [] },
        { id: "old-chat", name: "  Weekly   report  ", updatedAt: stale, turns: [turn("b", recent, "still")] },
        {
          id: "messy",
          updatedAt: recent,
          turns: [{ id: "c", role: "user", text: "no", at: stale }],
        },
      ],
    };
    const read = readAssistConversations(now, bookStore(JSON.stringify(raw)));
    expect(read.activeId).toBe("dup");
    expect(read.conversations.map((item) => item.id)).toEqual(["dup", "messy", "old-chat"]);
    expect(read.conversations[0]?.turns.map((item) => item.text)).toEqual(["kept"]);
    expect(read.conversations[1]?.name).toBe("New conversation");
    expect(read.conversations[1]?.turns).toEqual([]);
    expect(read.conversations[2]?.name).toBe("Weekly report");
  });

  test("renames, opens, creates, and removes a conversation", () => {
    const first = conversation("conv-1", "New conversation", older, [turn("old", stale), turn("live", recent, "one")]);
    const second = conversation("conv-2", "Taxes", newest, [turn("tax", recent, "tax")]);
    const saved = book("conv-1", [first, second]);

    expect(renameAssistConversation(saved, "missing", "Nope", now)).toBe(saved);
    expect(renameAssistConversation(saved, "conv-1", "New conversation", now)).toBe(saved);
    const named = renameAssistConversation(saved, "conv-1", "  Radiator\nsearch  ", now);
    expect(named.conversations[0]).toMatchObject({ name: "Radiator search" });
    expect(renameAssistConversation(named, "conv-2", "   ", now).conversations[1]?.name).toBe("New conversation");
    expect(renameAssistConversation(named, "conv-2", "x".repeat(80), now).conversations[1]?.name).toHaveLength(60);

    expect(selectAssistConversation(named, "conv-1", [], now)).toBeNull();
    expect(selectAssistConversation(named, "missing", [], now)).toBeNull();
    const opened = selectAssistConversation(
      book(named.activeId, [...named.conversations, conversation("conv-3", "Other", older)]),
      "conv-2",
      [turn("huge", recent, "y".repeat(1_600_000)), turn("live", recent, "one")],
      now,
    );
    expect(opened?.turns?.map((item) => item.text)).toEqual(["tax"]);
    expect(opened?.book.conversations.find((item) => item.id === "conv-1")?.turns.map((item) => item.text)).toEqual([
      "one",
    ]);
    expect(opened?.book.conversations.find((item) => item.id === "conv-3")?.name).toBe("Other");

    expect(createAssistConversation(saved, [], now, "bad id")).toBeNull();
    expect(createAssistConversation(saved, [], now, "conv-1")).toBeNull();
    const created = createAssistConversation(saved, [turn("live", recent, "one")], now, "conv-3");
    expect(created?.turns).toEqual([]);
    expect(created?.book.activeId).toBe("conv-3");
    expect(created?.book.conversations.map((item) => item.name)).toEqual([
      "New conversation 2",
      "Taxes",
      "New conversation",
    ]);
    const crowded = book(
      "conv-1",
      Array.from({ length: ASSIST_CONVERSATION_CAP + 1 }, (_, index) =>
        conversation(`n${index}`, index === 0 ? "New conversation" : `New conversation ${index + 1}`, older),
      ),
    );
    expect(createAssistConversation(crowded, [], now, "extra")?.book.conversations[0]?.name).toBe("New conversation");

    expect(removeAssistConversation(saved, "missing", now)).toBeNull();
    const cleared = removeAssistConversation(book("conv-1", [first]), "conv-1", now);
    expect(cleared?.turns).toEqual([]);
    expect(cleared?.book.conversations[0]?.name).toBe("New conversation");
    const removedIdle = removeAssistConversation(saved, "conv-2", now);
    expect(removedIdle?.turns).toBeNull();
    expect(removedIdle?.book.conversations.map((item) => item.id)).toEqual(["conv-1"]);
    const removedOpen = removeAssistConversation(
      book("conv-1", [first, conversation("conv-3", "Older purpose", older, [turn("o", recent, "old")]), second]),
      "conv-1",
      now,
    );
    expect(removedOpen?.book.activeId).toBe("conv-2");
    expect(removedOpen?.turns?.map((item) => item.text)).toEqual(["tax"]);
  });

  test("stores the list without copying the open messages, and gives up when the browser refuses", () => {
    const memory = bookStore();
    const saved = book("conv-1", [
      conversation("conv-1", "Open", newest, [turn("live", recent, "hidden")]),
      conversation("conv-2", "Kept", older, [turn("tax", recent, "tax")]),
    ]);
    writeAssistConversations(saved, now, memory);
    const read = readAssistConversations(now, memory);
    expect(read.conversations.find((item) => item.id === "conv-1")?.turns).toEqual([]);
    expect(read.conversations.find((item) => item.id === "conv-2")?.turns.map((item) => item.text)).toEqual(["tax"]);
    expect(touchAssistConversation(read, now).conversations[0]?.updatedAt).toBe(new Date(now).toISOString());
    expect(touchAssistConversation(book("missing", read.conversations), now)).toMatchObject({ activeId: "missing" });

    const crowded = book("conv-1", [
      conversation("conv-1", "Open", newest, [turn("live", recent, "hidden")]),
      conversation("conv-2", "Middle", older, [turn("tax", recent, "tax")]),
      conversation("conv-3", "Oldest", stale, [turn("z", recent, "z")]),
      conversation("conv-4", "Newest", newest, [turn("n", recent, "n")]),
      conversation("conv-5", "Also new", newest, [turn("q", recent, "q")]),
    ]);
    let attempts = 0;
    let stored = "";
    writeAssistConversations(crowded, now, {
      getItem: () => null,
      setItem: (_key, value) => {
        attempts += 1;
        if (attempts < 2) throw new Error("quota");
        stored = value;
      },
    });
    expect(JSON.parse(stored).conversations.map((item: { id: string }) => item.id)).toEqual([
      "conv-1",
      "conv-4",
      "conv-5",
      "conv-2",
    ]);

    let refused = 0;
    writeAssistConversations(crowded, now, {
      getItem: () => null,
      setItem: () => {
        refused += 1;
        throw new Error("quota");
      },
    });
    expect(refused).toBe(5);
    writeAssistConversations(book("conv-1", [conversation("conv-1", "Only", newest)]), now, {
      getItem: () => null,
      setItem: () => {
        refused += 1;
        throw new Error("quota");
      },
    });
    expect(refused).toBe(6);
  });
});
