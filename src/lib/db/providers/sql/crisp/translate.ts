/**
 * The SQL subset a Crisp connection runs.
 *
 * Crisp is a messaging API, not a SQL server. One SELECT becomes one GET
 * against the REST API: conversations, people, or operators. Filters are
 * equality only. Operators arrive in one response, and COUNT(*) is that
 * list's length. Conversations and people have no total, so a count is refused.
 */
import { QueryError } from "@/lib/db/errors";

const PROVIDER = "crisp" as const;

export interface CrispColumn {
  readonly name: string;
  readonly type: "varchar" | "double";
}

export interface CrispResource {
  readonly name: string;
  readonly columns: readonly CrispColumn[];
  /** SQL name → query parameter. */
  readonly filters: Readonly<Record<string, string>>;
  readonly enums: Readonly<Record<string, readonly string[]>>;
  readonly dates: readonly string[];
  readonly countable: boolean;
  readonly paging:
    | { readonly mode: "page"; readonly minLimit: number; readonly maxLimit: number; readonly maxPage: number }
    | { readonly mode: "once"; readonly maxLimit: number };
}

const text = (name: string): CrispColumn => ({ name, type: "varchar" });
const num = (name: string): CrispColumn => ({ name, type: "double" });

const FLAG = ["0", "1"] as const;

/** The lists this connection reads. Names are the ones the editor offers. */
export const CRISP_RESOURCES: readonly CrispResource[] = [
  {
    name: "Conversation",
    columns: [
      text("SessionId"),
      text("State"),
      text("Availability"),
      text("Nickname"),
      text("Email"),
      text("Country"),
      text("LastMessage"),
      text("Topic"),
      text("AssignedUserId"),
      text("PeopleId"),
      num("Unread"),
      text("IsBlocked"),
      text("CreatedAt"),
      text("UpdatedAt"),
    ],
    filters: {
      FilterUnread: "filter_unread",
      FilterResolved: "filter_resolved",
      FilterNotResolved: "filter_not_resolved",
      FilterUnassigned: "filter_unassigned",
      FilterAssigned: "filter_assigned",
      FilterDateStart: "filter_date_start",
      FilterDateEnd: "filter_date_end",
      SearchText: "search_query",
    },
    enums: {
      FilterUnread: FLAG,
      FilterResolved: FLAG,
      FilterNotResolved: FLAG,
      FilterUnassigned: FLAG,
    },
    dates: ["FilterDateStart", "FilterDateEnd"],
    countable: false,
    paging: { mode: "page", minLimit: 20, maxLimit: 50, maxPage: 50 },
  },
  {
    name: "People",
    columns: [
      text("PeopleId"),
      text("Email"),
      text("Nickname"),
      text("Phone"),
      text("Company"),
      text("Domain"),
      text("Segments"),
      num("Score"),
      text("CreatedAt"),
      text("UpdatedAt"),
    ],
    filters: {
      SearchText: "search_text",
      FilterDateStart: "filter_date_start",
      FilterDateEnd: "filter_date_end",
    },
    enums: {},
    dates: ["FilterDateStart", "FilterDateEnd"],
    countable: false,
    paging: { mode: "page", minLimit: 20, maxLimit: 50, maxPage: 50 },
  },
  {
    name: "Operator",
    columns: [
      text("UserId"),
      text("Email"),
      text("FirstName"),
      text("LastName"),
      text("Role"),
      text("Availability"),
      text("Type"),
    ],
    filters: {},
    enums: {},
    dates: [],
    countable: true,
    paging: { mode: "once", maxLimit: 200 },
  },
];

const BY_NAME = new Map(CRISP_RESOURCES.map((entry) => [entry.name.toLowerCase(), entry]));

/** The catalog table with this name, or null when the connection does not list it. */
export function crispResource(name: string): CrispResource | null {
  return BY_NAME.get(name.toLowerCase()) ?? null;
}

export interface CrispFilter {
  readonly name: string;
  readonly param: string;
  readonly value: string;
}

export interface CrispListStatement {
  readonly kind: "list";
  readonly resource: CrispResource;
  readonly columns: readonly string[] | null;
  readonly filters: readonly CrispFilter[];
  readonly limit: number;
  readonly offset: number;
  /** True when LIMIT was larger than the page the API returns. */
  readonly capped: boolean;
}

export interface CrispCountStatement {
  readonly kind: "count";
  readonly resource: CrispResource;
  readonly alias: string;
  readonly filters: readonly CrispFilter[];
}

export type CrispStatement = CrispListStatement | CrispCountStatement;

interface Word {
  readonly k: "word";
  readonly v: string;
}
interface Str {
  readonly k: "string";
  readonly v: string;
}
interface Num {
  readonly k: "number";
  readonly v: string;
}
interface Ident {
  readonly k: "ident";
  readonly v: string;
}
interface Mark {
  readonly k: "star" | "comma" | "eq" | "semi" | "lp" | "rp" | "cmp" | "dot";
}
type Token = Word | Str | Num | Ident | Mark;

const WRITES = new Set([
  "INSERT",
  "UPDATE",
  "DELETE",
  "DROP",
  "ALTER",
  "CREATE",
  "TRUNCATE",
  "MERGE",
  "REPLACE",
  "GRANT",
  "REVOKE",
]);

const PRINTABLE = /^[\x20-\x7e]+$/;
const DATE_VALUE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}(?:T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?Z)?$/;

function fail(sql: string, message: string): never {
  throw new QueryError(message, PROVIDER, sql);
}

function tokens(sql: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < sql.length) {
    const c = sql[i] ?? "";
    if (c === " " || c === "\n" || c === "\r" || c === "\t") {
      i += 1;
      continue;
    }
    if (c === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end < 0) fail(sql, "Crisp comment was not closed.");
      i = end + 2;
      continue;
    }
    if (c === "'") {
      let value = "";
      i += 1;
      let closed = false;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          value += "'";
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          closed = true;
          i += 1;
          break;
        }
        value += sql[i];
        i += 1;
      }
      if (!closed) fail(sql, "Crisp string was not closed.");
      out.push({ k: "string", v: value });
      continue;
    }
    if (c === '"') {
      let value = "";
      i += 1;
      let closed = false;
      while (i < sql.length) {
        if (sql[i] === '"' && sql[i + 1] === '"') {
          value += '"';
          i += 2;
          continue;
        }
        if (sql[i] === '"') {
          closed = true;
          i += 1;
          break;
        }
        value += sql[i];
        i += 1;
      }
      if (!closed) fail(sql, "Crisp name was not closed.");
      out.push({ k: "ident", v: value });
      continue;
    }
    if (c === "?" || c === "$") fail(sql, "Write the value in the statement. Crisp does not bind parameters.");
    if (c === "*") {
      out.push({ k: "star" });
      i += 1;
      continue;
    }
    if (c === ",") {
      out.push({ k: "comma" });
      i += 1;
      continue;
    }
    if (c === "=") {
      out.push({ k: "eq" });
      i += 1;
      continue;
    }
    if (c === "<" || c === ">" || c === "!") {
      while (i < sql.length && "<>!=".includes(sql[i] ?? "")) i += 1;
      out.push({ k: "cmp" });
      continue;
    }
    if (c === ";") {
      out.push({ k: "semi" });
      i += 1;
      continue;
    }
    if (c === ".") {
      out.push({ k: "dot" });
      i += 1;
      continue;
    }
    if (c === "(") {
      out.push({ k: "lp" });
      i += 1;
      continue;
    }
    if (c === ")") {
      out.push({ k: "rp" });
      i += 1;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let value = "";
      while (i < sql.length && /[0-9.]/.test(sql[i] ?? "")) {
        value += sql[i];
        i += 1;
      }
      if (value.endsWith(".") || value.split(".").length > 2) fail(sql, "Crisp could not read that number.");
      out.push({ k: "number", v: value });
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let value = "";
      while (i < sql.length && /[A-Za-z0-9_]/.test(sql[i] ?? "")) {
        value += sql[i];
        i += 1;
      }
      out.push({ k: "word", v: value });
      continue;
    }
    fail(sql, "Crisp could not read that statement.");
  }
  return out;
}

function word(token: Token | undefined): string | null {
  if (token === undefined) return null;
  if (token.k === "word") return token.v;
  if (token.k === "ident") return token.v;
  return null;
}

function same(token: Token | undefined, expected: string): boolean {
  return token?.k === "word" && token.v.toUpperCase() === expected;
}

function filterParam(resource: CrispResource, column: string): string | undefined {
  if (resource.filters[column] !== undefined) return resource.filters[column];
  const found = Object.keys(resource.filters).find((key) => key.toLowerCase() === column.toLowerCase());
  return found === undefined ? undefined : resource.filters[found];
}

function filterName(resource: CrispResource, column: string): string {
  if (resource.filters[column] !== undefined) return column;
  return Object.keys(resource.filters).find((key) => key.toLowerCase() === column.toLowerCase()) ?? column;
}

function checkFilter(sql: string, resource: CrispResource, name: string, value: string): void {
  const allowed = resource.enums[name];
  if (allowed !== undefined && !allowed.includes(value)) {
    fail(sql, `Crisp ${name} must be 0 or 1.`);
  }
  if (resource.dates.includes(name)) {
    if (!DATE_VALUE.test(value) || !Number.isFinite(Date.parse(value))) {
      fail(sql, "Crisp dates are calendar days or instants, such as 2024-07-18 or 2024-07-18T00:00:00Z.");
    }
  } else if (allowed === undefined && (!PRINTABLE.test(value) || value.length > 200)) {
    fail(sql, "Crisp filter values are printable text, at most 200 characters.");
  }
}

/** One read-only statement, or a refusal that names what the subset cannot do. */
export function translateCrispSql(sql: string): CrispStatement {
  const scanned = tokens(sql);
  if (scanned.length === 0) fail(sql, "Crisp needs a SELECT.");
  const first = word(scanned[0]);
  if (first !== null && WRITES.has(first.toUpperCase())) {
    fail(sql, "Crisp is read-only. A write is refused before a request.");
  }
  if (!same(scanned[0], "SELECT")) fail(sql, "Crisp runs one SELECT or COUNT(*).");

  let at = 1;
  const count = same(scanned[at], "COUNT");
  let columns: string[] | null = null;
  let alias = "totalCount";
  if (count) {
    at += 1;
    if (scanned[at]?.k !== "lp" || scanned[at + 1]?.k !== "star" || scanned[at + 2]?.k !== "rp") {
      fail(sql, "Crisp counts with COUNT(*).");
    }
    at += 3;
    if (same(scanned[at], "AS")) {
      const name = word(scanned[at + 1]);
      if (name === null || name === "" || same(scanned[at + 1], "FROM") || same(scanned[at + 1], "WHERE")) {
        fail(sql, "Crisp needs a name after AS.");
      }
      alias = name;
      at += 2;
    }
  } else if (scanned[at]?.k === "star") {
    columns = null;
    at += 1;
  } else {
    const names: string[] = [];
    while (at < scanned.length && !same(scanned[at], "FROM")) {
      const name = word(scanned[at]);
      if (name === null) fail(sql, "Crisp needs a column name.");
      names.push(name);
      at += 1;
      if (scanned[at]?.k === "comma") at += 1;
    }
    if (names.length === 0) fail(sql, "Crisp needs a column name.");
    columns = names;
  }

  if (!same(scanned[at], "FROM")) fail(sql, "Crisp needs FROM and one table.");
  at += 1;
  const table = word(scanned[at]);
  if (table === null) fail(sql, "Crisp needs FROM and one table.");
  const found = crispResource(table);
  if (found === null) fail(sql, `Crisp has no table named ${table}.`);
  at += 1;

  const filters: CrispFilter[] = [];
  if (same(scanned[at], "WHERE")) {
    at += 1;
    for (;;) {
      if (same(scanned[at], "OR")) fail(sql, "Crisp combines filters with AND.");
      if (same(scanned[at], "LIKE") || same(scanned[at], "IN") || same(scanned[at], "BETWEEN")) {
        fail(sql, "Crisp filters with =.");
      }
      const column = word(scanned[at]);
      if (column === null) fail(sql, "Crisp needs a column after WHERE.");
      at += 1;
      if (scanned[at]?.k === "cmp") fail(sql, "Crisp filters with =.");
      if (scanned[at]?.k !== "eq") fail(sql, "Crisp filters with =.");
      at += 1;
      const value = literal(sql, scanned[at]);
      at += 1;
      const param = filterParam(found, column);
      if (param === undefined) fail(sql, `Crisp cannot filter ${found.name} on ${column}.`);
      const name = filterName(found, column);
      checkFilter(sql, found, name, value);
      filters.push({ name, param, value });
      if (same(scanned[at], "AND")) {
        at += 1;
        continue;
      }
      if (same(scanned[at], "OR")) fail(sql, "Crisp combines filters with AND.");
      break;
    }
  }

  if (count && !found.countable) {
    fail(sql, `Crisp does not return a total for ${found.name}. Read a page with LIMIT and OFFSET.`);
  }

  if (same(scanned[at], "ORDER")) fail(sql, "Crisp does not sort a page.");
  if (same(scanned[at], "JOIN") || scanned[at]?.k === "dot") fail(sql, "Crisp reads one table.");
  if (same(scanned[at], "GROUP") || same(scanned[at], "UNION")) fail(sql, "Crisp reads one table.");

  const starts = filters.filter((filter) => filter.name.endsWith("Start"));
  for (const start of starts) {
    const endName = start.name.replace(/Start$/, "End");
    const end = filters.find((filter) => filter.name === endName)?.value;
    if (end !== undefined && Date.parse(end) < Date.parse(start.value)) {
      fail(sql, `Crisp ${endName} must be the same instant as ${start.name} or later.`);
    }
  }

  const ceiling = found.paging.maxLimit;
  const floor = found.paging.mode === "page" ? found.paging.minLimit : ceiling;
  let limit = floor;
  let offset = 0;
  let capped = false;
  if (same(scanned[at], "LIMIT")) {
    if (count) fail(sql, "COUNT(*) does not take LIMIT.");
    at += 1;
    const parsed = whole(sql, scanned[at], "LIMIT");
    at += 1;
    if (parsed < 1) fail(sql, "LIMIT must be a positive whole number.");
    if (found.paging.mode === "page" && parsed < found.paging.minLimit) {
      fail(sql, "Crisp pages are from 20 to 50 rows.");
    }
    if (parsed > ceiling) {
      limit = ceiling;
      capped = true;
    } else {
      limit = parsed;
    }
  }
  if (same(scanned[at], "OFFSET")) {
    if (count) fail(sql, "COUNT(*) does not take OFFSET.");
    at += 1;
    offset = whole(sql, scanned[at], "OFFSET");
    at += 1;
    if (found.paging.mode === "page") {
      if (offset % limit !== 0) fail(sql, "OFFSET must be a multiple of LIMIT, because Crisp reads pages.");
      if (offset / limit + 1 > found.paging.maxPage) fail(sql, "Crisp pages stop at 50.");
    } else if (offset > 10_000) {
      fail(sql, "OFFSET must be at most 10000.");
    }
  }
  if (scanned[at]?.k === "semi") at += 1;
  if (at < scanned.length) fail(sql, "Crisp runs one statement.");

  if (count) return { kind: "count", resource: found, alias, filters };
  return { kind: "list", resource: found, columns, filters, limit, offset, capped };
}

function literal(sql: string, token: Token | undefined): string {
  if (token?.k === "string") return token.v;
  if (token?.k === "number") return token.v;
  if (token?.k === "word" && (token.v.toLowerCase() === "true" || token.v.toLowerCase() === "false")) {
    return token.v.toLowerCase();
  }
  fail(sql, "Crisp filters on a quoted value, a number, or true and false.");
}

function whole(sql: string, token: Token | undefined, label: string): number {
  if (token?.k !== "number" || !/^[0-9]+$/.test(token.v)) fail(sql, `${label} must be a whole number.`);
  return Number(token.v);
}
