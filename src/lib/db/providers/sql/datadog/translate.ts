/**
 * The SQL subset a Datadog connection runs.
 *
 * Datadog is a monitoring API, not a SQL server. One SELECT becomes one GET:
 * monitors, hosts, or dashboards. Filters are equality only. Monitors and hosts
 * return a total, so COUNT(*) is that total. Dashboards do not, so a count is refused.
 */
import { QueryError } from "@/lib/db/errors";

const PROVIDER = "datadog" as const;

export interface DatadogColumn {
  readonly name: string;
  readonly type: "varchar" | "double";
}

export interface DatadogResource {
  readonly name: string;
  readonly columns: readonly DatadogColumn[];
  /** SQL name → query parameter. `query` is composed, not copied. */
  readonly filters: Readonly<Record<string, string>>;
  readonly enums: Readonly<Record<string, readonly string[]>>;
  readonly numbers: readonly string[];
  readonly countable: boolean;
  readonly paging: {
    readonly minLimit: number;
    readonly maxLimit: number;
    readonly defaultLimit: number;
    readonly maxOffset: number;
  };
}

const text = (name: string): DatadogColumn => ({ name, type: "varchar" });
const num = (name: string): DatadogColumn => ({ name, type: "double" });

const STATUS = ["Alert", "Warn", "OK", "No Data", "Ignored", "Skipped", "Unknown"] as const;
const BOOL = ["true", "false"] as const;
const SORT_DIR = ["asc", "desc"] as const;

/** The lists this connection reads. Names are the ones the editor offers. */
export const DATADOG_RESOURCES: readonly DatadogResource[] = [
  {
    name: "Monitor",
    columns: [
      text("Id"),
      text("Name"),
      text("Type"),
      text("Status"),
      text("Query"),
      text("Tags"),
      text("Scopes"),
      text("Metrics"),
      text("CreatorName"),
      text("CreatorEmail"),
      text("Notifications"),
      text("LastTriggered"),
      text("Classification"),
      text("OrgId"),
    ],
    filters: { Query: "query", Status: "status" },
    enums: { Status: STATUS },
    numbers: [],
    countable: true,
    paging: { minLimit: 1, maxLimit: 100, defaultLimit: 30, maxOffset: 10_000 },
  },
  {
    name: "Host",
    columns: [
      text("Id"),
      text("Name"),
      text("HostName"),
      text("AwsName"),
      text("Aliases"),
      text("Apps"),
      text("Sources"),
      text("Tags"),
      text("IsMuted"),
      text("Up"),
      text("LastReported"),
      num("Cpu"),
      num("IoWait"),
      num("Load"),
      text("AgentVersion"),
      text("Platform"),
      text("Machine"),
    ],
    filters: { Filter: "filter", SortField: "sort_field", SortDir: "sort_dir", From: "from" },
    enums: { SortDir: SORT_DIR },
    numbers: ["From"],
    countable: true,
    paging: { minLimit: 1, maxLimit: 1000, defaultLimit: 100, maxOffset: 10_000 },
  },
  {
    name: "Dashboard",
    columns: [
      text("Id"),
      text("Title"),
      text("Description"),
      text("AuthorHandle"),
      text("LayoutType"),
      text("IsReadOnly"),
      text("Url"),
      text("CreatedAt"),
      text("ModifiedAt"),
    ],
    filters: { Shared: "filter[shared]", Deleted: "filter[deleted]" },
    enums: { Shared: BOOL, Deleted: BOOL },
    numbers: [],
    countable: false,
    paging: { minLimit: 1, maxLimit: 100, defaultLimit: 100, maxOffset: 10_000 },
  },
];

const BY_NAME = new Map(DATADOG_RESOURCES.map((entry) => [entry.name.toLowerCase(), entry]));

/** The catalog table with this name, or null when the connection does not list it. */
export function datadogResource(name: string): DatadogResource | null {
  return BY_NAME.get(name.toLowerCase()) ?? null;
}

export interface DatadogFilter {
  readonly name: string;
  readonly param: string;
  readonly value: string;
}

export interface DatadogListStatement {
  readonly kind: "list";
  readonly resource: DatadogResource;
  readonly columns: readonly string[] | null;
  readonly filters: readonly DatadogFilter[];
  readonly limit: number;
  readonly offset: number;
  /** True when LIMIT was larger than the page the API returns. */
  readonly capped: boolean;
}

export interface DatadogCountStatement {
  readonly kind: "count";
  readonly resource: DatadogResource;
  readonly alias: string;
  readonly filters: readonly DatadogFilter[];
}

export type DatadogStatement = DatadogListStatement | DatadogCountStatement;

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
const SORT_FIELD = /^[a-z][a-z0-9_]{0,31}$/;

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
      if (end < 0) fail(sql, "Datadog comment was not closed.");
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
      if (!closed) fail(sql, "Datadog string was not closed.");
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
      if (!closed) fail(sql, "Datadog name was not closed.");
      out.push({ k: "ident", v: value });
      continue;
    }
    if (c === "?" || c === "$") fail(sql, "Write the value in the statement. Datadog does not bind parameters.");
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
      if (value.endsWith(".") || value.split(".").length > 2) fail(sql, "Datadog could not read that number.");
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
    fail(sql, "Datadog could not read that statement.");
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

function filterParam(resource: DatadogResource, column: string): string | undefined {
  if (resource.filters[column] !== undefined) return resource.filters[column];
  const found = Object.keys(resource.filters).find((key) => key.toLowerCase() === column.toLowerCase());
  return found === undefined ? undefined : resource.filters[found];
}

function filterName(resource: DatadogResource, column: string): string {
  if (resource.filters[column] !== undefined) return column;
  return Object.keys(resource.filters).find((key) => key.toLowerCase() === column.toLowerCase()) ?? column;
}

function allowedList(values: readonly string[]): string {
  if (values.length === 1) return values[0] ?? "";
  return `${values.slice(0, -1).join(", ")} or ${values.at(-1)}`;
}

function checkFilter(sql: string, resource: DatadogResource, name: string, value: string): void {
  const allowed = resource.enums[name];
  if (allowed !== undefined && !allowed.includes(value)) {
    fail(sql, `Datadog ${name} must be ${allowedList(allowed)}.`);
  }
  if (resource.numbers.includes(name)) {
    if (!/^[0-9]{1,16}$/.test(value)) fail(sql, `Datadog ${name} is a whole number of seconds.`);
    return;
  }
  if (name === "SortField" && !SORT_FIELD.test(value)) {
    fail(sql, "Datadog SortField is a short name such as name or cpu.");
  }
  if (allowed === undefined && name !== "SortField" && (!PRINTABLE.test(value) || value.length > 200)) {
    fail(sql, "Datadog filter values are printable text, at most 200 characters.");
  }
}

/** One read-only statement, or a refusal that names what the subset cannot do. */
export function translateDatadogSql(sql: string): DatadogStatement {
  const scanned = tokens(sql);
  if (scanned.length === 0) fail(sql, "Datadog needs a SELECT.");
  const first = word(scanned[0]);
  if (first !== null && WRITES.has(first.toUpperCase())) {
    fail(sql, "Datadog is read-only. A write is refused before a request.");
  }
  if (!same(scanned[0], "SELECT")) fail(sql, "Datadog runs one SELECT or COUNT(*).");

  let at = 1;
  const count = same(scanned[at], "COUNT");
  let columns: string[] | null = null;
  let alias = "totalCount";
  if (count) {
    at += 1;
    if (scanned[at]?.k !== "lp" || scanned[at + 1]?.k !== "star" || scanned[at + 2]?.k !== "rp") {
      fail(sql, "Datadog counts with COUNT(*).");
    }
    at += 3;
    if (same(scanned[at], "AS")) {
      const name = word(scanned[at + 1]);
      if (name === null || name === "" || same(scanned[at + 1], "FROM") || same(scanned[at + 1], "WHERE")) {
        fail(sql, "Datadog needs a name after AS.");
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
      if (name === null) fail(sql, "Datadog needs a column name.");
      names.push(name);
      at += 1;
      if (scanned[at]?.k === "comma") at += 1;
    }
    if (names.length === 0) fail(sql, "Datadog needs a column name.");
    columns = names;
  }

  if (!same(scanned[at], "FROM")) fail(sql, "Datadog needs FROM and one table.");
  at += 1;
  const table = word(scanned[at]);
  if (table === null) fail(sql, "Datadog needs FROM and one table.");
  const found = datadogResource(table);
  if (found === null) fail(sql, `Datadog has no table named ${table}.`);
  at += 1;

  const filters: DatadogFilter[] = [];
  if (same(scanned[at], "WHERE")) {
    at += 1;
    for (;;) {
      if (same(scanned[at], "OR")) fail(sql, "Datadog combines filters with AND.");
      if (same(scanned[at], "LIKE") || same(scanned[at], "IN") || same(scanned[at], "BETWEEN")) {
        fail(sql, "Datadog filters with =.");
      }
      const column = word(scanned[at]);
      if (column === null) fail(sql, "Datadog needs a column after WHERE.");
      at += 1;
      if (scanned[at]?.k === "cmp") fail(sql, "Datadog filters with =.");
      if (scanned[at]?.k !== "eq") fail(sql, "Datadog filters with =.");
      at += 1;
      const value = literal(sql, scanned[at]);
      at += 1;
      const param = filterParam(found, column);
      if (param === undefined) fail(sql, `Datadog cannot filter ${found.name} on ${column}.`);
      const name = filterName(found, column);
      checkFilter(sql, found, name, value);
      filters.push({ name, param, value });
      if (same(scanned[at], "AND")) {
        at += 1;
        continue;
      }
      if (same(scanned[at], "OR")) fail(sql, "Datadog combines filters with AND.");
      break;
    }
  }

  if (filters.some((filter) => filter.name === "Shared") && filters.some((filter) => filter.name === "Deleted")) {
    fail(sql, "Datadog reads shared dashboards or deleted dashboards, not both.");
  }

  if (count && !found.countable) {
    fail(sql, `Datadog does not return a total for ${found.name}. Read a page with LIMIT and OFFSET.`);
  }

  if (same(scanned[at], "ORDER")) fail(sql, "Datadog does not sort a page.");
  if (same(scanned[at], "JOIN") || scanned[at]?.k === "dot") fail(sql, "Datadog reads one table.");
  if (same(scanned[at], "GROUP") || same(scanned[at], "UNION")) fail(sql, "Datadog reads one table.");

  const ceiling = found.paging.maxLimit;
  let limit = found.paging.defaultLimit;
  let offset = 0;
  let capped = false;
  if (same(scanned[at], "LIMIT")) {
    if (count) fail(sql, "COUNT(*) does not take LIMIT.");
    at += 1;
    const parsed = whole(sql, scanned[at], "LIMIT");
    at += 1;
    if (parsed < 1) fail(sql, "LIMIT must be a positive whole number.");
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
    if (offset % limit !== 0) fail(sql, "OFFSET must be a multiple of LIMIT, because Datadog reads pages.");
    if (offset > found.paging.maxOffset) fail(sql, "OFFSET must be at most 10000.");
  }
  if (scanned[at]?.k === "semi") at += 1;
  if (at < scanned.length) fail(sql, "Datadog runs one statement.");

  if (count) return { kind: "count", resource: found, alias, filters };
  return { kind: "list", resource: found, columns, filters, limit, offset, capped };
}

function literal(sql: string, token: Token | undefined): string {
  if (token?.k === "string") return token.v;
  if (token?.k === "number") return token.v;
  if (token?.k === "word" && (token.v.toLowerCase() === "true" || token.v.toLowerCase() === "false")) {
    return token.v.toLowerCase();
  }
  fail(sql, "Datadog filters on a quoted value, a number, or true and false.");
}

function whole(sql: string, token: Token | undefined, label: string): number {
  if (token?.k !== "number" || !/^[0-9]+$/.test(token.v)) fail(sql, `${label} must be a whole number.`);
  return Number(token.v);
}
