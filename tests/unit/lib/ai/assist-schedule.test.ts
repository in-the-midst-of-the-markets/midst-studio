import "../../../setup-dom";
import { describe, expect, test } from "bun:test";
import { ASSIST_TEXT_CAP } from "@/lib/ai/assist-plan";
import { ASSIST_SAVED_LIST_CAP } from "@/lib/ai/assist-saved";
import {
  ASSIST_SCHEDULE_CAP,
  ASSIST_SCHEDULE_DAILY_SECONDS,
  ASSIST_SCHEDULE_DEFAULT_MINUTE,
  ASSIST_SCHEDULE_HOURLY_SECONDS,
  ASSIST_SCHEDULE_KEY,
  ASSIST_START_TIMES,
  assistCalendarCells,
  assistDateKey,
  assistDayLabel,
  assistMinuteLabel,
  assistMonthLabel,
  assistScheduleEvery,
  assistScheduleLabel,
  draftAssistSchedule,
  nextAssistRunDelayMs,
  readAssistDate,
  readAssistInterval,
  readAssistScheduleSnapshot,
  readAssistSchedules,
  shiftAssistMonth,
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
        {
          id: "morning",
          prompt: "Standup",
          seconds: ASSIST_SCHEDULE_DAILY_SECONDS,
          minuteOfDay: 540.8,
          startsOn: "2026-11-20",
        },
        {
          id: "broken-day",
          prompt: "Later",
          seconds: ASSIST_SCHEDULE_DAILY_SECONDS,
          minuteOfDay: 600,
          startsOn: "2026-02-29",
        },
        {
          id: "broken-time",
          prompt: "Never",
          seconds: ASSIST_SCHEDULE_DAILY_SECONDS,
          minuteOfDay: 24 * 60,
          startsOn: "2026-11-20",
        },
        { id: "hourly-clock", prompt: "Often", seconds: ASSIST_SCHEDULE_HOURLY_SECONDS, minuteOfDay: 60 },
      ]),
    );
    expect(readAssistSchedules(store)).toEqual([
      { id: "s1", prompt: "What changed?", sourceIds: [], seconds: ASSIST_SCHEDULE_HOURLY_SECONDS },
      { id: "sources", prompt: "", sourceIds: ["q1"], seconds: ASSIST_SCHEDULE_HOURLY_SECONDS },
      { id: "day", prompt: "Tomorrow", sourceIds: [], seconds: ASSIST_SCHEDULE_DAILY_SECONDS },
      {
        id: "morning",
        prompt: "Standup",
        sourceIds: [],
        seconds: ASSIST_SCHEDULE_DAILY_SECONDS,
        minuteOfDay: 540,
        startsOn: "2026-11-20",
      },
      {
        id: "broken-day",
        prompt: "Later",
        sourceIds: [],
        seconds: ASSIST_SCHEDULE_DAILY_SECONDS,
        minuteOfDay: 600,
      },
      { id: "broken-time", prompt: "Never", sourceIds: [], seconds: ASSIST_SCHEDULE_DAILY_SECONDS },
      { id: "hourly-clock", prompt: "Often", sourceIds: [], seconds: ASSIST_SCHEDULE_HOURLY_SECONDS },
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
    expect(
      assistScheduleLabel(
        schedule({ seconds: ASSIST_SCHEDULE_DAILY_SECONDS, minuteOfDay: ASSIST_SCHEDULE_DEFAULT_MINUTE }),
        [],
      ),
    ).toBe("What changed? · Daily at 9:00 AM");
    expect(
      assistScheduleLabel(
        schedule({
          seconds: ASSIST_SCHEDULE_DAILY_SECONDS,
          minuteOfDay: 15 * 60 + 30,
          startsOn: "2099-06-15",
        }),
        [],
      ),
    ).toBe("What changed? · Daily at 3:30 PM · Jun 15");
    expect(
      assistScheduleLabel(
        schedule({
          seconds: ASSIST_SCHEDULE_DAILY_SECONDS,
          minuteOfDay: 0,
          startsOn: "2000-01-01",
        }),
        [],
      ),
    ).toBe("What changed? · Daily at 12:00 AM");
    expect(assistMinuteLabel(12 * 60)).toBe("12:00 PM");
  });

  test("picks a day and a start time on the calendar", () => {
    expect(readAssistDate("")).toBeNull();
    expect(readAssistDate("2026-02-29")).toBeNull();
    expect(readAssistDate("2026-11-31")).toBeNull();
    expect(readAssistDate(" 2026-11-13 ")).toBe("2026-11-13");
    expect(assistDayLabel("nope")).toBe("nope");
    expect(assistDayLabel("2026-11-13")).toBe("Friday, November 13, 2026");
    expect(assistMonthLabel(2026, 10)).toBe("November 2026");
    expect(shiftAssistMonth(2026, 0, -1)).toEqual({ year: 2025, month: 11 });
    expect(shiftAssistMonth(2026, 11, 1)).toEqual({ year: 2027, month: 0 });
    const cells = assistCalendarCells(2026, 10);
    expect(cells).toHaveLength(42);
    expect(cells[0]?.key).toBe(assistDateKey(new Date(2026, 10, 1 - new Date(2026, 10, 1).getDay())));
    expect(cells.filter((cell) => cell.inMonth)).toHaveLength(30);
    expect(ASSIST_START_TIMES[0]).toBe(0);
    expect(ASSIST_START_TIMES[18]).toBe(ASSIST_SCHEDULE_DEFAULT_MINUTE);
    expect(ASSIST_START_TIMES).toHaveLength(48);

    const morning = new Date(2026, 10, 13, 8, 0, 0, 0);
    const atNine = {
      seconds: ASSIST_SCHEDULE_DAILY_SECONDS,
      minuteOfDay: ASSIST_SCHEDULE_DEFAULT_MINUTE,
      startsOn: "2026-11-13",
    };
    expect(nextAssistRunDelayMs(atNine, morning)).toBe(60 * 60 * 1000);
    expect(nextAssistRunDelayMs(atNine, new Date(2026, 10, 13, 10, 0, 0, 0))).toBe(23 * 60 * 60 * 1000);
    expect(nextAssistRunDelayMs(atNine, new Date(2026, 10, 13, 9, 0, 0, 0))).toBe(ASSIST_SCHEDULE_DAILY_SECONDS * 1000);
    expect(nextAssistRunDelayMs({ ...atNine, startsOn: "2026-11-20" }, morning)).toBe(
      new Date(2026, 10, 20, 9, 0, 0, 0).getTime() - morning.getTime(),
    );
    expect(nextAssistRunDelayMs({ seconds: ASSIST_SCHEDULE_DAILY_SECONDS, minuteOfDay: 9 * 60 }, morning)).toBe(
      60 * 60 * 1000,
    );
    expect(
      nextAssistRunDelayMs({ seconds: ASSIST_SCHEDULE_DAILY_SECONDS, minuteOfDay: 9 * 60, startsOn: "nope" }, morning),
    ).toBe(60 * 60 * 1000);
    expect(nextAssistRunDelayMs({ seconds: ASSIST_SCHEDULE_HOURLY_SECONDS }, morning)).toBe(
      ASSIST_SCHEDULE_HOURLY_SECONDS * 1000,
    );
    expect(nextAssistRunDelayMs({ seconds: ASSIST_SCHEDULE_DAILY_SECONDS }, morning)).toBe(
      ASSIST_SCHEDULE_DAILY_SECONDS * 1000,
    );
    expect(nextAssistRunDelayMs({ seconds: ASSIST_SCHEDULE_DAILY_SECONDS, minuteOfDay: -1 }, morning)).toBe(
      ASSIST_SCHEDULE_DAILY_SECONDS * 1000,
    );
    expect(nextAssistRunDelayMs({ seconds: 0 }, morning)).toBeNull();
    expect(nextAssistRunDelayMs({ seconds: Number.NaN }, morning)).toBeNull();

    expect(
      draftAssistSchedule({
        id: "s1",
        prompt: "Standup",
        sourceIds: [],
        every: "daily",
        existing: 0,
        minuteOfDay: 24 * 60,
        startsOn: "2026-11-13",
      }),
    ).toEqual({ ok: false, error: "Choose a time." });
    expect(
      draftAssistSchedule({
        id: "s1",
        prompt: "Standup",
        sourceIds: [],
        every: "daily",
        existing: 0,
        minuteOfDay: Number.NaN,
      }),
    ).toEqual({ ok: false, error: "Choose a time." });
    expect(
      draftAssistSchedule({
        id: "s1",
        prompt: "Standup",
        sourceIds: [],
        every: "daily",
        existing: 0,
        minuteOfDay: 9 * 60,
        startsOn: "2026-11-31",
      }),
    ).toEqual({ ok: false, error: "Choose a day." });
    expect(
      draftAssistSchedule({
        id: "s1",
        prompt: "Standup",
        sourceIds: [],
        every: "daily",
        existing: 0,
        minuteOfDay: 9 * 60,
        startsOn: "2026-11-13",
      }),
    ).toEqual({
      ok: true,
      schedule: {
        id: "s1",
        prompt: "Standup",
        sourceIds: [],
        seconds: ASSIST_SCHEDULE_DAILY_SECONDS,
        minuteOfDay: 9 * 60,
        startsOn: "2026-11-13",
      },
    });
    const open = draftAssistSchedule({
      id: "s1",
      prompt: "Standup",
      sourceIds: [],
      every: "daily",
      existing: 0,
      minuteOfDay: 9 * 60,
      startsOn: "  ",
    });
    expect(open.ok).toBe(true);
    if (open.ok) expect(open.schedule.startsOn).toBeUndefined();
  });
});
