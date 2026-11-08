import "../../../setup-dom";
import { describe, expect, test } from "bun:test";
import { ASSIST_TEXT_CAP } from "@/lib/ai/assist-plan";
import { ASSIST_SAVED_LIST_CAP } from "@/lib/ai/assist-saved";
import {
  ASSIST_SCHEDULE_CAP,
  ASSIST_SCHEDULE_DAILY_SECONDS,
  ASSIST_SCHEDULE_HOURLY_SECONDS,
  ASSIST_SCHEDULE_KEY,
  assistScheduleEvery,
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
  return { id: "s1", prompt: "What changed?", sourceIds: [], seconds: ASSIST_SCHEDULE_HOURLY_SECONDS, ...patch };
}

describe("assist schedules", () => {
  test("reads hourly or daily and refuses anything else", () => {
    expect(readAssistInterval("")).toEqual({ ok: false, error: "Choose hourly or daily." });
    expect(readAssistInterval("soon").ok).toBe(false);
    expect(readAssistInterval("60").ok).toBe(false);
    expect(readAssistInterval(" Hourly ")).toEqual({ ok: true, seconds: ASSIST_SCHEDULE_HOURLY_SECONDS });
    expect(readAssistInterval("daily")).toEqual({ ok: true, seconds: ASSIST_SCHEDULE_DAILY_SECONDS });
    expect(assistScheduleEvery(ASSIST_SCHEDULE_HOURLY_SECONDS)).toBe("hourly");
    expect(assistScheduleEvery(ASSIST_SCHEDULE_DAILY_SECONDS)).toBe("daily");
  });

  test("keeps a prompt or a source on an hourly or daily gap", () => {
    expect(draftAssistSchedule({ id: "s1", prompt: "  ", sourceIds: [], every: "hourly", existing: 0 })).toEqual({
      ok: false,
      error: "Write a prompt or add a source.",
    });
    expect(draftAssistSchedule({ id: "s1", prompt: "What changed?", sourceIds: [], every: "", existing: 0 }).ok).toBe(
      false,
    );
    expect(
      draftAssistSchedule({
        id: "s1",
        prompt: "What changed?",
        sourceIds: [],
        every: "nope",
        existing: ASSIST_SCHEDULE_CAP,
      }),
    ).toEqual({ ok: false, error: `${ASSIST_SCHEDULE_CAP} schedules are the most this page keeps.` });
    const hourly = draftAssistSchedule({
      id: "  ",
      prompt: `  ${"a".repeat(ASSIST_TEXT_CAP + 5)}`,
      sourceIds: [" q1 ", "", "q1", "q2"],
      every: "hourly",
      existing: 0,
    });
    expect(hourly).toEqual({
      ok: true,
      schedule: {
        id: "schedule",
        prompt: "a".repeat(ASSIST_TEXT_CAP),
        sourceIds: ["q1", "q2"],
        seconds: ASSIST_SCHEDULE_HOURLY_SECONDS,
      },
    });
    const ids = Array.from({ length: ASSIST_SAVED_LIST_CAP + 2 }, (_, index) => `q${index}`);
    const sourced = draftAssistSchedule({
      id: "s2",
      prompt: "",
      sourceIds: ids,
      every: "daily",
      existing: 0,
    });
    expect(sourced.ok).toBe(true);
    if (sourced.ok) {
      expect(sourced.schedule.sourceIds).toHaveLength(ASSIST_SAVED_LIST_CAP);
      expect(sourced.schedule.seconds).toBe(ASSIST_SCHEDULE_DAILY_SECONDS);
    }
  });

  test("drops a broken record and reads an old seconds value as hourly or daily", () => {
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
        { id: "day", prompt: "Tomorrow", seconds: 90_000 },
        { id: "bad", prompt: "no", seconds: 0 },
        { prompt: "missing id", seconds: 60 },
      ]),
    );
    expect(readAssistSchedules(store)).toEqual([
      { id: "s1", prompt: "What changed?", sourceIds: [], seconds: ASSIST_SCHEDULE_HOURLY_SECONDS },
      { id: "sources", prompt: "", sourceIds: ["q1"], seconds: ASSIST_SCHEDULE_HOURLY_SECONDS },
      { id: "day", prompt: "Tomorrow", sourceIds: [], seconds: ASSIST_SCHEDULE_DAILY_SECONDS },
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
    expect(assistScheduleLabel(schedule({ prompt: "What changed?\nMore" }), [])).toBe("What changed? · Hourly");
    expect(
      assistScheduleLabel(schedule({ prompt: "   \nMore", sourceIds: ["q1", "gone"] }), [{ id: "q1", name: "Orders" }]),
    ).toBe("Saved sources · Orders · Hourly");
    expect(assistScheduleLabel(schedule({ seconds: ASSIST_SCHEDULE_DAILY_SECONDS }), [])).toBe("What changed? · Daily");
  });
});
