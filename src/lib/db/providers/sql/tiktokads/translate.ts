/**
 * The SQL subset a TikTok Ads connection runs.
 *
 * TikTok Ads is a Marketing API, not a SQL server. The editor still speaks SQL, and this module
 * turns one SELECT into one API v1.3 list of one standard resource. Filters, order and the
 * page are applied to that answer. A write, a join and a second statement fail here, before
 * a request. Reporting metrics and the next page are not requested.
 */
import { QueryError } from "@/lib/db/errors";

const PROVIDER = "tiktokads" as const;

/** One list page. The Marketing API's maximum `page_size` is 1000, and Studio does not request page 2. */
export const TIKTOK_ADS_ROW_CAP = 1000;
const DEFAULT_LIMIT = 100;
const READ_ONLY = "TikTok Ads is read-only. Studio runs SELECT and refuses a write.";
const ONE_STATEMENT = "TikTok Ads runs one statement. Remove the second statement.";
const NO_COUNT = "TikTok Ads has no COUNT(*). Select a column, such as campaign.name.";

export type TikTokAdsType = "text" | "number";

export interface TikTokAdsColumn {
  readonly name: string;
  readonly type: TikTokAdsType;
  /** The JSON field on the entity. */
  readonly json: string;
}

export interface TikTokAdsResource {
  readonly name: string;
  readonly primary: string;
  readonly path: string;
  readonly columns: readonly TikTokAdsColumn[];
}

export type TikTokAdsCompare = "=" | "!=" | "<>" | "<" | ">" | "<=" | ">=";

export interface TikTokAdsFilter {
  readonly field: string;
  readonly operator: TikTokAdsCompare | "LIKE" | "IS NULL" | "IS NOT NULL";
  readonly value: string;
}

export interface TikTokAdsOrder {
  readonly column: string;
  readonly desc: boolean;
}

export interface TikTokAdsSelect {
  readonly kind: "select";
  readonly resource: TikTokAdsResource;
  readonly columns: readonly string[] | null;
  readonly filters: readonly TikTokAdsFilter[];
  readonly orderBy: TikTokAdsOrder | null;
  readonly limit: number;
  readonly offset: number;
  readonly capped: boolean;
}

function column(name: string, type: TikTokAdsType, json: string): TikTokAdsColumn {
  return { name, type, json };
}

function resource(name: string, primary: string, path: string, columns: readonly TikTokAdsColumn[]): TikTokAdsResource {
  return { name, primary, path, columns };
}

/** The standard resources this connection reads. Each one is one Marketing API v1.3 list. */
export const TIKTOK_ADS_RESOURCES: readonly TikTokAdsResource[] = Object.freeze([
  resource("campaign", "campaign.id", "/open_api/v1.3/campaign/get/", [
    column("campaign.id", "text", "campaign_id"),
    column("campaign.name", "text", "campaign_name"),
    column("campaign.operation_status", "text", "operation_status"),
    column("campaign.objective_type", "text", "objective_type"),
    column("campaign.budget_mode", "text", "budget_mode"),
    column("campaign.budget", "number", "budget"),
    column("campaign.modify_time", "text", "modify_time"),
  ]),
  resource("ad_group", "ad_group.id", "/open_api/v1.3/adgroup/get/", [
    column("ad_group.id", "text", "adgroup_id"),
    column("ad_group.name", "text", "adgroup_name"),
    column("ad_group.operation_status", "text", "operation_status"),
    column("campaign.id", "text", "campaign_id"),
    column("ad_group.budget", "number", "budget"),
    column("ad_group.modify_time", "text", "modify_time"),
  ]),
  resource("ad", "ad.id", "/open_api/v1.3/ad/get/", [
    column("ad.id", "text", "ad_id"),
    column("ad.name", "text", "ad_name"),
    column("ad.operation_status", "text", "operation_status"),
    column("ad_group.id", "text", "adgroup_id"),
    column("campaign.id", "text", "campaign_id"),
    column("ad.modify_time", "text", "modify_time"),
  ]),
]);

export function tiktokAdsResource(name: string): TikTokAdsResource | undefined {
  const key = name.toLowerCase();
  return TIKTOK_ADS_RESOURCES.find((item) => item.name === key);
}

export function tiktokAdsColumn(table: TikTokAdsResource, name: string): TikTokAdsColumn | undefined {
  const key = name.toLowerCase();
  return table.columns.find((item) => item.name === key);
}

function fail(message: string, sql: string): never {
  throw new QueryError(message, PROVIDER, sql);
}

type Token =
  | { readonly t: "word"; readonly v: string }
  | { readonly t: "ident"; readonly v: string }
  | { readonly t: "string"; readonly v: string }
  | { readonly t: "number"; readonly v: string }
  | { readonly t: "eof" };

function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const length = sql.length;
  while (i < length) {
    const c = sql[i] ?? "";
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i += 1;
      continue;
    }
    if (c === "-" && sql[i + 1] === "-") {
      i += 2;
      while (i < length && sql[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      i += 2;
      const close = sql.indexOf("*/", i);
      if (close < 0) fail("Close the block comment.", sql);
      i = close + 2;
      continue;
    }
    if (c === "'") {
      let value = "";
      i += 1;
      while (i < length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          value += "'";
          i += 2;
          continue;
        }
        if (sql[i] === "'") break;
        value += sql[i];
        i += 1;
      }
      if (sql[i] !== "'") fail("Close the quoted text.", sql);
      tokens.push({ t: "string", v: value });
      i += 1;
      continue;
    }
    if (c === '"') {
      let value = "";
      i += 1;
      while (i < length) {
        if (sql[i] === '"' && sql[i + 1] === '"') {
          value += '"';
          i += 2;
          continue;
        }
        if (sql[i] === '"') break;
        value += sql[i];
        i += 1;
      }
      if (sql[i] !== '"') fail("Close the quoted name.", sql);
      tokens.push({ t: "ident", v: value });
      i += 1;
      continue;
    }
    if (c === "<" && sql[i + 1] === ">") {
      tokens.push({ t: "word", v: "<>" });
      i += 2;
      continue;
    }
    if (c === "=" || c === ">" || c === "<" || c === "!") {
      const next = sql[i + 1];
      if ((c === "<" || c === ">" || c === "!") && next === "=") {
        tokens.push({ t: "word", v: `${c}=` });
        i += 2;
        continue;
      }
      if (c === "!") fail(READ_ONLY, sql);
      tokens.push({ t: "word", v: c });
      i += 1;
      continue;
    }
    if (c === "*" || c === "(" || c === ")" || c === ",") {
      tokens.push({ t: "word", v: c });
      i += 1;
      continue;
    }
    if (c === ";") {
      const rest = sql.slice(i + 1).trim();
      if (rest !== "") fail(ONE_STATEMENT, sql);
      break;
    }
    if (c === "-" || (c >= "0" && c <= "9")) {
      const number = readNumber(sql, i);
      if (number === null) fail(READ_ONLY, sql);
      tokens.push({ t: "number", v: number.value });
      i = number.end;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let raw = "";
      while (i < length && /[A-Za-z0-9_]/.test(sql[i] ?? "")) {
        raw += sql[i];
        i += 1;
      }
      while (sql[i] === "." && /[A-Za-z_]/.test(sql[i + 1] ?? "")) {
        raw += ".";
        i += 1;
        while (i < length && /[A-Za-z0-9_]/.test(sql[i] ?? "")) {
          raw += sql[i];
          i += 1;
        }
      }
      tokens.push({ t: "word", v: raw });
      continue;
    }
    fail(READ_ONLY, sql);
  }
  tokens.push({ t: "eof" });
  return tokens;
}

function readNumber(sql: string, start: number): { value: string; end: number } | null {
  let i = start;
  let raw = "";
  if (sql[i] === "-") {
    if ((sql[i + 1] ?? "") < "0" || (sql[i + 1] ?? "") > "9") return null;
    raw = "-";
    i += 1;
  }
  const digits = i;
  while (i < sql.length && (sql[i] ?? "") >= "0" && (sql[i] ?? "") <= "9") {
    raw += sql[i];
    i += 1;
  }
  if (i === digits) return null;
  if (sql[i] === "." && (sql[i + 1] ?? "") >= "0" && (sql[i + 1] ?? "") <= "9") {
    raw += ".";
    i += 1;
    while (i < sql.length && (sql[i] ?? "") >= "0" && (sql[i] ?? "") <= "9") {
      raw += sql[i];
      i += 1;
    }
  }
  return { value: raw, end: i };
}

const SAFE_NAME = /^[A-Za-z_][A-Za-z0-9_.]*$/;

function safeName(name: string, sql: string): string {
  if (name.length > 80 || !SAFE_NAME.test(name)) fail("Write a field name without spaces or punctuation.", sql);
  return name;
}

class Parser {
  private index = 0;

  constructor(
    private readonly tokens: readonly Token[],
    private readonly sql: string,
  ) {}

  private peek(): Token {
    return this.tokens[this.index] ?? { t: "eof" };
  }

  private word(expected?: string): string | null {
    const token = this.peek();
    if (token.t !== "word") return null;
    if (expected !== undefined && token.v.toUpperCase() !== expected) return null;
    this.index += 1;
    return token.v;
  }

  private name(): string {
    const token = this.peek();
    this.index += 1;
    if (token.t === "word" || token.t === "ident") return safeName(token.v, this.sql);
    fail("Write a field name.", this.sql);
  }

  parse(): TikTokAdsSelect {
    const first = this.word();
    if (first === null || first.toUpperCase() !== "SELECT") fail(READ_ONLY, this.sql);
    if (this.word("DISTINCT") !== null) fail("TikTok Ads reads one SELECT without DISTINCT.", this.sql);
    if (this.word("COUNT") !== null) fail(NO_COUNT, this.sql);
    return this.select();
  }

  private table(): TikTokAdsResource {
    if (this.word("FROM") === null) fail("Write FROM and one resource, such as campaign.", this.sql);
    const found = tiktokAdsResource(this.name());
    if (found === undefined) fail("TikTok Ads has no resource with that name.", this.sql);
    return found;
  }

  private field(table: TikTokAdsResource): TikTokAdsColumn {
    const written = this.name();
    const found = tiktokAdsColumn(table, written);
    if (found === undefined) fail(`TikTok Ads has no field named ${written} on ${table.name}.`, this.sql);
    return found;
  }

  private select(): TikTokAdsSelect {
    const star = this.word("*") !== null;
    const names: string[] = [];
    if (!star) {
      names.push(this.name());
      while (this.word(",") !== null) names.push(this.name());
    }
    const table = this.table();
    const columns = star ? null : names.map((written) => this.known(table, written));
    const filters = this.filters(table);
    const orderBy = this.order(table);
    const page = this.page();
    this.end();
    return { kind: "select", resource: table, columns, filters, orderBy, ...page };
  }

  private known(table: TikTokAdsResource, written: string): string {
    const found = tiktokAdsColumn(table, written);
    if (found === undefined) fail(`TikTok Ads has no field named ${written} on ${table.name}.`, this.sql);
    return found.name;
  }

  private filters(table: TikTokAdsResource): TikTokAdsFilter[] {
    if (this.word("WHERE") === null) return [];
    const filters = [this.predicate(table)];
    while (this.word("AND") !== null) filters.push(this.predicate(table));
    if (this.word("OR") !== null) fail("Combine filters with AND. TikTok Ads does not read OR here.", this.sql);
    return filters;
  }

  private predicate(table: TikTokAdsResource): TikTokAdsFilter {
    const field = this.field(table);
    if (this.word("IS") !== null) {
      const not = this.word("NOT") !== null;
      if (this.word("NULL") === null) fail("Write IS NULL or IS NOT NULL.", this.sql);
      return { field: field.name, operator: not ? "IS NOT NULL" : "IS NULL", value: "" };
    }
    const operator = this.word();
    if (
      operator !== "=" &&
      operator !== "!=" &&
      operator !== "<>" &&
      operator !== "<" &&
      operator !== ">" &&
      operator !== "<=" &&
      operator !== ">=" &&
      (operator === null || operator.toUpperCase() !== "LIKE")
    ) {
      fail("Compare with =, !=, <, >, <=, >=, or LIKE.", this.sql);
    }
    const written = operator?.toUpperCase() === "LIKE" ? "LIKE" : (operator as TikTokAdsCompare);
    return { field: field.name, operator: written, value: this.literal(field, written) };
  }

  private literal(field: TikTokAdsColumn, operator: TikTokAdsCompare | "LIKE"): string {
    if (operator === "LIKE") {
      if (field.type !== "text") fail("LIKE applies to a text field.", this.sql);
      const token = this.peek();
      this.index += 1;
      if (token.t !== "string") fail("Write the LIKE pattern in quotes.", this.sql);
      return token.v;
    }
    const token = this.peek();
    this.index += 1;
    if (field.type === "text") {
      if (token.t !== "string") fail("Write that value in quotes.", this.sql);
      return token.v;
    }
    if (token.t !== "number" || !/^-?\d+(\.\d+)?$/.test(token.v)) fail("Write a number.", this.sql);
    return token.v;
  }

  private order(table: TikTokAdsResource): TikTokAdsOrder | null {
    if (this.word("ORDER") === null) return null;
    if (this.word("BY") === null) fail("Write ORDER BY and one field.", this.sql);
    const ordered = this.field(table).name;
    const desc = this.word("DESC") !== null;
    if (!desc) this.word("ASC");
    if (this.word(",") !== null) fail("TikTok Ads orders by one field.", this.sql);
    return { column: ordered, desc };
  }

  private page(): { limit: number; offset: number; capped: boolean } {
    let limit = DEFAULT_LIMIT;
    let capped = false;
    if (this.word("LIMIT") !== null) {
      const written = this.whole("Write LIMIT as a positive whole number.");
      if (written < 1) fail("Write LIMIT as a positive whole number.", this.sql);
      if (written > TIKTOK_ADS_ROW_CAP) {
        limit = TIKTOK_ADS_ROW_CAP;
        capped = true;
      } else limit = written;
    }
    let offset = 0;
    if (this.word("OFFSET") !== null) offset = this.whole("Write OFFSET as a whole number.");
    if (offset > 0 && offset + limit > TIKTOK_ADS_ROW_CAP) capped = true;
    return { limit, offset, capped };
  }

  private whole(message: string): number {
    const token = this.peek();
    this.index += 1;
    if (token.t !== "number" || !/^\d+$/.test(token.v)) fail(message, this.sql);
    const value = Number(token.v);
    if (!Number.isSafeInteger(value)) fail(message, this.sql);
    return value;
  }

  private end(): void {
    if (this.peek().t !== "eof") fail(READ_ONLY, this.sql);
  }
}

/** One statement, or a refusal that names what to write instead. */
export function translateTikTokAdsSql(sql: string): TikTokAdsSelect {
  const text = sql.trim();
  if (text === "") fail("Write a SELECT.", sql);
  return new Parser(tokenize(text), text).parse();
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return null;
}

function textOf(value: unknown): string | null {
  if (value === null || (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean"))
    return null;
  return String(value);
}

function like(text: string, pattern: string): boolean {
  const source = pattern
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replaceAll("%", ".*")
    .replaceAll("_", ".");
  return new RegExp(`^${source}$`).test(text);
}

function matches(column: TikTokAdsColumn, value: unknown, filter: TikTokAdsFilter): boolean {
  if (filter.operator === "IS NULL") return value === null;
  if (filter.operator === "IS NOT NULL") return value !== null;
  if (filter.operator === "LIKE") {
    const text = textOf(value);
    return text !== null && like(text, filter.value);
  }
  if (column.type === "number") {
    const left = asNumber(value);
    const right = Number(filter.value);
    if (left === null || !Number.isFinite(right)) return false;
    if (filter.operator === "=") return left === right;
    if (filter.operator === "!=" || filter.operator === "<>") return left !== right;
    if (filter.operator === "<") return left < right;
    if (filter.operator === ">") return left > right;
    if (filter.operator === "<=") return left <= right;
    return left >= right;
  }
  const text = textOf(value);
  if (text === null) return false;
  if (filter.operator === "=") return text === filter.value;
  if (filter.operator === "!=" || filter.operator === "<>") return text !== filter.value;
  if (filter.operator === "<") return text < filter.value;
  if (filter.operator === ">") return text > filter.value;
  if (filter.operator === "<=") return text <= filter.value;
  return text >= filter.value;
}

function cell(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rowOf(entry: unknown, table: TikTokAdsResource, sql: string): Record<string, unknown> {
  if (!isRecord(entry)) fail("TikTok Ads's answer was not a list.", sql);
  const row: Record<string, unknown> = {};
  for (const item of table.columns) row[item.name] = cell(entry[item.json]);
  return row;
}

function sortValue(column: TikTokAdsColumn, value: unknown): number | string | null {
  if (value === null) return null;
  if (column.type === "number") {
    const parsed = asNumber(value);
    return parsed === null ? textOf(value) : parsed;
  }
  return textOf(value);
}

/** The page of rows one Marketing API list becomes. */
export function tiktokAdsRows(
  statement: TikTokAdsSelect,
  entries: readonly unknown[],
  sql: string,
): Record<string, unknown>[] {
  const rows = entries.map((entry) => rowOf(entry, statement.resource, sql));
  const kept = rows.filter((row) =>
    statement.filters.every((filter) => {
      const item = tiktokAdsColumn(statement.resource, filter.field);
      return item !== undefined && matches(item, row[filter.field], filter);
    }),
  );
  const order = statement.orderBy;
  if (order !== null) {
    const item = tiktokAdsColumn(statement.resource, order.column);
    if (item !== undefined) {
      kept.sort((left, right) => {
        const a = sortValue(item, left[order.column]);
        const b = sortValue(item, right[order.column]);
        if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
        if (typeof a === "number" && typeof b === "number") return order.desc ? b - a : a - b;
        const text = String(a).localeCompare(String(b));
        return order.desc ? -text : text;
      });
    }
  }
  return kept.slice(statement.offset, statement.offset + statement.limit);
}
