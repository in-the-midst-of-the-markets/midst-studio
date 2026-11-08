import "../../../setup-dom";
import { describe, expect, test } from "bun:test";
import { ASSIST_TEXT_CAP } from "@/lib/ai/assist-plan";
import { ASSIST_SAVED_LIST_CAP } from "@/lib/ai/assist-saved";
import {
  ASSIST_SCHEDULE_CAP,
  ASSIST_SCHEDULE_KEY,
  assistScheduleLabel,
  draftAssistSchedule,
  readAssistInterval,
  readAssistScheduleSnapshot,
  readAssistSchedules,
  subscribeAssistSchedules,
  writeAssistSchedules,
  type AssistSchedule,
} from "@/lib/ai/assist-schedule";

function memory() {
  const items = new Map<string, string>();
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => {
      items.set(key, value);
    },
  };
}

function schedule(patch: Partial<AssistSchedule> = {}): AssistSchedule {
  return { id: "s1", prompt: "What changed?", sourceIds: [], seconds: 60, ...patch };
}

describe("assist schedules", () => {
  test("reads an interval and refuses a blank or a word", () => {
    expect(readAssistInterval("")).toEqual({ ok: false, error: "Name how many seconds between runs." });
    expect(readAssistInterval("soon").ok).toBe(false);
    expect(readAssistInterval("1")).toEqual({ ok: true, seconds: 60, raised: true });
    expect(readAssistInterval("120")).toEqual({ ok: true, seconds: 120, raised: false });
  });

  test("keeps a prompt or a source, and raises a short interval", () => {
    expect(draftAssistSchedule({ id: "s1", prompt: "  ", sourceIds: [], intervalText: "60", existing: 0 })).toEqual({
      ok: false,
      error: "Write a prompt or add a source.",
    });
    expect(
      draftAssistSchedule({ id: "s1", prompt: "What changed?", sourceIds: [], intervalText: "", existing: 0 }).ok,
    ).toBe(false);
    expect(
      draftAssistSchedule({
        id: "s1",
        prompt: "What changed?",
        sourceIds: [],
        intervalText: "nope",
        existing: ASSIST_SCHEDULE_CAP,
      }),
    ).toEqual({ ok: false, error: `${ASSIST_SCHEDULE_CAP} schedules are the most this page keeps.` });
    const raised = draftAssistSchedule({
      id: "  ",
      prompt: `  ${"a".repeat(ASSIST_TEXT_CAP + 5)}`,
      sourceIds: [" q1 ", "", "q1", "q2"],
      intervalText: "5",
      existing: 0,
    });
    expect(raised).toEqual({
      ok: true,
      raised: true,
      schedule: {
        id: "schedule",
        prompt: "a".repeat(ASSIST_TEXT_CAP),
        sourceIds: ["q1", "q2"],
        seconds: 60,
      },
    });
    const ids = Array.from({ length: ASSIST_SAVED_LIST_CAP + 2 }, (_, index) => `q${index}`);
    const sourced = draftAssistSchedule({
      id: "s2",
      prompt: "",
      sourceIds: ids,
      intervalText: "90",
      existing: 0,
    });
    expect(sourced.ok).toBe(true);
    if (sourced.ok) expect(sourced.schedule.sourceIds).toHaveLength(ASSIST_SAVED_LIST_CAP);
  });

  test("drops a broken record and keeps a short interval at the floor", () => {
    const store = memory();
    expect(readAssistSchedules(store)).toEqual([]);
    store.setItem(ASSIST_SCHEDULE_KEY, "");
    expect(readAssistSchedules(store)).toEqual([]);
    store.setItem(ASSIST_SCHEDULE_KEY, "{");
    expect(readAssistSchedules(store)).toEqual([]);
    store.setItem(ASSIST_SCHEDULE_KEY, "{}");
    expect(readAssistSchedules(store)).toEqual([]);
    store.setItem(
      ASSIST_SCHEDULE_KEY,
      JSON.stringify([
        null,
        { id: " ", prompt: "x", seconds: 60 },
        { id: "empty", prompt: " ", sourceIds: [], seconds: 60 },
        { id: "s1", prompt: "What changed?", seconds: 15 },
        { id: "s1", prompt: "again", seconds: 60 },
        { id: "sources", prompt: "", sourceIds: ["q1", 2, "q1"], seconds: 120 },
        { id: "bad", prompt: "no", seconds: 0 },
        { prompt: "missing id", seconds: 60 },
      ]),
    );
    expect(readAssistSchedules(store)).toEqual([
      { id: "s1", prompt: "What changed?", sourceIds: [], seconds: 60 },
      { id: "sources", prompt: "", sourceIds: ["q1"], seconds: 120 },
    ]);
    const extra = Array.from({ length: ASSIST_SCHEDULE_CAP + 1 }, (_, index) => schedule({ id: `s${index}` }));
    writeAssistSchedules(extra, store);
    expect(readAssistSchedules(store)).toHaveLength(ASSIST_SCHEDULE_CAP);
  });

  test("tells the page when the browser copy changes", () => {
    localStorage.removeItem(ASSIST_SCHEDULE_KEY);
    let heard = 0;
    const stop = subscribeAssistSchedules(() => {
      heard += 1;
    });
    writeAssistSchedules([schedule()], localStorage);
    const first = readAssistScheduleSnapshot();
    expect(first).toEqual([schedule()]);
    expect(readAssistScheduleSnapshot()).toBe(first);
    expect(heard).toBe(1);
    stop();
    writeAssistSchedules([], localStorage);
    expect(heard).toBe(1);
    expect(readAssistScheduleSnapshot()).toEqual([]);
  });

  test("names a schedule from its first line and its sources", () => {
    expect(assistScheduleLabel(schedule({ prompt: "What changed?\nMore" }), [])).toBe("What changed? · every 60s");
    expect(
      assistScheduleLabel(schedule({ prompt: "   \nMore", sourceIds: ["q1", "gone"] }), [{ id: "q1", name: "Orders" }]),
    ).toBe("Saved sources · Orders · every 60s");
  });
});
