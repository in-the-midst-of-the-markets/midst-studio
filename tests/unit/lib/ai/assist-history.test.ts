import { describe, expect, test } from "bun:test";
import {
  ASSIST_RETENTION_MS,
  ASSIST_TRANSCRIPT_KEY,
  readAssistTranscript,
  writeAssistTranscript,
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
