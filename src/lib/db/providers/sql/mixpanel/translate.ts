/**
 * The SQL subset a Mixpanel connection runs.
 *
 * Mixpanel is a REST API, not a SQL server. The editor still speaks SQL, and this module
 * turns one SELECT into one list. Filters, order and the page are applied to that
 * answer. A write, a join and a second statement fail here, before a request.
 */
import { QueryError } from "@/lib/db/errors";
import {
  listedResource,
  listedRows,
  translateListedSql,
  type ListedColumn,
  type ListedProduct,
  type ListedResource,
  type ListedSelect,
} from "../listed-select";

/** The largest page Studio keeps from one Mixpanel list. */
export const MIXPANEL_ROW_CAP = 100;

const PROVIDER = "mixpanel" as const;

export type MixpanelColumn = ListedColumn;
export type MixpanelResource = ListedResource;
export type MixpanelSelect = ListedSelect;

interface MixpanelList {
  readonly method: "GET" | "POST";
  readonly path: "events" | "annotations" | "cohorts";
  readonly listKey: string | null;
}

function column(name: string, type: ListedColumn["type"], json: string): MixpanelColumn {
  return { name, type, json };
}

function resource(name: string, primary: string, path: string, columns: readonly MixpanelColumn[]): MixpanelResource {
  return { name, primary, path, columns };
}

/** The lists the object tree shows. Each one is one Mixpanel read. */
export const MIXPANEL_RESOURCES: readonly MixpanelResource[] = Object.freeze([
  resource("event", "event.name", "/api/query/events/top", [
    column("event.name", "text", "name"),
    column("event.count", "number", "count"),
    column("event.change", "number", "change"),
  ]),
  resource("annotation", "annotation.id", "/api/app/projects/{projectId}/annotations", [
    column("annotation.id", "number", "id"),
    column("annotation.date", "text", "date"),
    column("annotation.description", "text", "description"),
  ]),
  resource("cohort", "cohort.id", "/api/query/cohorts/list", [
    column("cohort.id", "number", "id"),
    column("cohort.name", "text", "name"),
    column("cohort.count", "number", "count"),
    column("cohort.created", "text", "created"),
    column("cohort.visible", "text", "visible"),
  ]),
]);

const LISTS: Readonly<Record<string, MixpanelList>> = Object.freeze({
  event: { method: "GET", path: "events", listKey: "events" },
  annotation: { method: "GET", path: "annotations", listKey: "results" },
  cohort: { method: "POST", path: "cohorts", listKey: null },
});

const MIXPANEL: ListedProduct = {
  provider: PROVIDER,
  rowCap: MIXPANEL_ROW_CAP,
  resources: MIXPANEL_RESOURCES,
  product: "Mixpanel",
  example: "event",
  exampleColumn: "event.name",
};

export function mixpanelResource(name: string): MixpanelResource | undefined {
  return listedResource(MIXPANEL, name);
}

export interface MixpanelCall {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly params: URLSearchParams;
}

/** The request for one list. Events ask for today's top names, capped at the row limit. */
export function mixpanelCall(name: string, projectId: string, eventLimit = String(MIXPANEL_ROW_CAP)): MixpanelCall {
  const list = LISTS[name];
  const params = new URLSearchParams();
  if (list === undefined) return { method: "GET", path: "/", params };
  if (list.path === "events") {
    params.set("project_id", projectId);
    params.set("type", "general");
    params.set("limit", eventLimit);
    return { method: list.method, path: "/api/query/events/top", params };
  }
  if (list.path === "annotations") {
    return { method: list.method, path: `/api/app/projects/${projectId}/annotations`, params };
  }
  params.set("project_id", projectId);
  return { method: list.method, path: "/api/query/cohorts/list", params };
}

/** One statement, or a refusal that names what to write instead. */
export function translateMixpanelSql(sql: string): MixpanelSelect {
  return translateListedSql(sql, MIXPANEL);
}

/** The page of rows one Mixpanel list becomes, after the provider has flattened it. */
export function mixpanelRows(
  statement: MixpanelSelect,
  entries: readonly unknown[],
  sql: string,
): Record<string, unknown>[] {
  return listedRows(MIXPANEL, statement, entries, sql);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function flatten(name: string, entry: unknown): unknown {
  if (!isRecord(entry)) return entry;
  if (name === "event") {
    return {
      name: entry.event ?? null,
      count: entry.amount ?? null,
      change: entry.percent_change ?? null,
    };
  }
  if (name === "annotation") {
    return {
      id: entry.id ?? null,
      date: entry.date ?? null,
      description: entry.description ?? null,
    };
  }
  return {
    id: entry.id ?? null,
    name: entry.name ?? null,
    count: entry.count ?? null,
    created: entry.created ?? null,
    visible: entry.is_visible === 1 ? "yes" : "no",
  };
}

/** The flattened rows of one Mixpanel answer, or a refusal when the body is not that list. */
export function mixpanelEntries(name: string, body: unknown): unknown[] {
  const list = LISTS[name];
  if (list === undefined) throw new QueryError("Mixpanel's answer was not a list.", PROVIDER);
  if (list.listKey === null) {
    if (!Array.isArray(body)) throw new QueryError("Mixpanel's answer was not a list.", PROVIDER);
    return body.map((entry) => flatten(name, entry));
  }
  if (!isRecord(body)) throw new QueryError("Mixpanel's answer was not a list.", PROVIDER);
  const entries = body[list.listKey];
  if (entries === undefined || entries === null) return [];
  if (!Array.isArray(entries)) throw new QueryError("Mixpanel's answer was not a list.", PROVIDER);
  return entries.map((entry) => flatten(name, entry));
}

/** Whether the answer filled the page Studio asked for. The next page is not requested. */
export function mixpanelHasMore(name: string, body: unknown): boolean {
  try {
    return mixpanelEntries(name, body).length >= MIXPANEL_ROW_CAP;
  } catch {
    return false;
  }
}
