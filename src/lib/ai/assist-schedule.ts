/**
 * A prompt the AI page runs again on a timer.
 *
 * The prompt and the saved-query sources are copied when the schedule is saved.
 * Each run reads those sources again, so a query that changed, or rows that
 * changed, are what the next answer sees. A schedule repeats hourly or daily.
 */

import { ASSIST_TEXT_CAP } from "@/lib/ai/assist-plan";
import { ASSIST_SAVED_LIST_CAP } from "@/lib/ai/assist-saved";

export const ASSIST_SCHEDULE_KEY = "libredb_ai_assist_schedules";
export const ASSIST_SCHEDULE_CAP = 8;
export const ASSIST_SCHEDULE_HOURLY_SECONDS = 60 * 60;
export const ASSIST_SCHEDULE_DAILY_SECONDS = 24 * 60 * 60;

export type AssistScheduleEvery = "hourly" | "daily";

export interface AssistSchedule {
  readonly id: string;
  readonly prompt: string;
  readonly sourceIds: readonly string[];
  readonly seconds: number;
}

interface ScheduleStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type AssistScheduleDraft =
  | { readonly ok: true; readonly schedule: AssistSchedule }
  | { readonly ok: false; readonly error: string };

type AssistIntervalRead =
  | { readonly ok: true; readonly seconds: number }
  | { readonly ok: false; readonly error: string };

function secondsFor(every: AssistScheduleEvery): number {
  return every === "daily" ? ASSIST_SCHEDULE_DAILY_SECONDS : ASSIST_SCHEDULE_HOURLY_SECONDS;
}

/** Hourly, unless the stored gap is at least a day. */
export function assistScheduleEvery(seconds: number): AssistScheduleEvery {
  return seconds >= ASSIST_SCHEDULE_DAILY_SECONDS ? "daily" : "hourly";
}

function clipPrompt(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > ASSIST_TEXT_CAP ? trimmed.slice(0, ASSIST_TEXT_CAP) : trimmed;
}

function sourceIdsOf(ids: readonly string[]): string[] {
  const kept: string[] = [];
  for (const id of ids) {
    const trimmed = id.trim();
    if (trimmed === "" || kept.includes(trimmed)) continue;
    kept.push(trimmed);
    if (kept.length === ASSIST_SAVED_LIST_CAP) break;
  }
  return kept;
}

/** Hourly or daily. Anything else is not a schedule. */
export function readAssistInterval(text: string): AssistIntervalRead {
  const every = text.trim().toLowerCase();
  if (every === "hourly" || every === "daily") return { ok: true, seconds: secondsFor(every) };
  return { ok: false, error: "Choose hourly or daily." };
}

/**
 * One schedule from the prompt on screen, the sources added to it, and the interval.
 * A prompt or a source is enough. Neither is not.
 */
export function draftAssistSchedule(input: {
  readonly id: string;
  readonly prompt: string;
  readonly sourceIds: readonly string[];
  readonly every: string;
  readonly existing: number;
}): AssistScheduleDraft {
  if (input.existing >= ASSIST_SCHEDULE_CAP) {
    return { ok: false, error: `${ASSIST_SCHEDULE_CAP} schedules are the most this page keeps.` };
  }
  const interval = readAssistInterval(input.every);
  if (!interval.ok) return interval;
  const prompt = clipPrompt(input.prompt);
  const sourceIds = sourceIdsOf(input.sourceIds);
  if (prompt === "" && sourceIds.length === 0) {
    return { ok: false, error: "Write a prompt or add a source." };
  }
  return {
    ok: true,
    schedule: { id: input.id.trim() || "schedule", prompt, sourceIds, seconds: interval.seconds },
  };
}

function scheduleOf(value: unknown): AssistSchedule | null {
  if (value === null || typeof value !== "object") return null;
  const id = "id" in value && typeof value.id === "string" ? value.id.trim() : "";
  if (id === "") return null;
  const prompt = "prompt" in value && typeof value.prompt === "string" ? clipPrompt(value.prompt) : "";
  const rawIds = "sourceIds" in value && Array.isArray(value.sourceIds) ? value.sourceIds : [];
  const sourceIds = sourceIdsOf(rawIds.filter((item): item is string => typeof item === "string"));
  const seconds = "seconds" in value && typeof value.seconds === "number" ? Math.floor(value.seconds) : 0;
  if (prompt === "" && sourceIds.length === 0) return null;
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return { id, prompt, sourceIds, seconds: secondsFor(assistScheduleEvery(seconds)) };
}

/** Schedules kept in this browser. A broken record is left out. */
export function readAssistSchedules(store: ScheduleStore = localStorage): readonly AssistSchedule[] {
  const raw = store.getItem(ASSIST_SCHEDULE_KEY);
  if (raw === null || raw === "") return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const schedules: AssistSchedule[] = [];
    for (const item of parsed) {
      const schedule = scheduleOf(item);
      if (schedule === null || schedules.some((kept) => kept.id === schedule.id)) continue;
      schedules.push(schedule);
      if (schedules.length === ASSIST_SCHEDULE_CAP) break;
    }
    return schedules;
  } catch {
    return [];
  }
}

const listeners = new Set<() => void>();

/** Tells the page the saved schedules changed. */
export function subscribeAssistSchedules(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

let cachedRaw = "\u0000";
let cachedSchedules: readonly AssistSchedule[] = [];

/** The schedules last read, stable while the stored text is unchanged. */
export function readAssistScheduleSnapshot(): readonly AssistSchedule[] {
  const raw = localStorage.getItem(ASSIST_SCHEDULE_KEY) ?? "";
  if (raw === cachedRaw) return cachedSchedules;
  cachedRaw = raw;
  cachedSchedules = readAssistSchedules();
  return cachedSchedules;
}

/** Replaces the saved schedules and tells the page. */
export function writeAssistSchedules(schedules: readonly AssistSchedule[], store: ScheduleStore = localStorage): void {
  store.setItem(ASSIST_SCHEDULE_KEY, JSON.stringify(schedules.slice(0, ASSIST_SCHEDULE_CAP)));
  if (store === localStorage) {
    cachedRaw = "\u0000";
    for (const listener of listeners) listener();
  }
}

/** The words shown for one schedule. The first line of the prompt, then its sources. */
export function assistScheduleLabel(
  schedule: AssistSchedule,
  picks: readonly { readonly id: string; readonly name: string }[],
): string {
  const names = schedule.sourceIds.flatMap((id) => {
    const pick = picks.find((item) => item.id === id);
    return pick === undefined ? [] : [pick.name];
  });
  const first = schedule.prompt.split("\n")[0]?.trim() ?? "";
  const lead = first === "" ? "Saved sources" : first;
  const extra = names.length === 0 ? "" : ` · ${names.join(", ")}`;
  const cadence = assistScheduleEvery(schedule.seconds) === "daily" ? "Daily" : "Hourly";
  return `${lead}${extra} · ${cadence}`;
}
