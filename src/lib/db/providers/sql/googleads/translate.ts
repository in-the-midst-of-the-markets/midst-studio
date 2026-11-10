/**
 * The SQL subset a Google Ads connection runs.
 *
 * Google Ads is a query API, not a SQL server. The editor still speaks SQL, and this module
 * turns one SELECT into one Google Ads Query Language search of one standard resource.
 * A write, a join and a second statement fail here, before a request. Ad Manager, Search Ads 360,
 * and custom resources are not this connection.
 */
import { QueryError } from "@/lib/db/errors";

const PROVIDER = "googleads" as const;

export const GOOGLE_ADS_ROW_CAP = 1000;
const DEFAULT_LIMIT = 100;
const READ_ONLY = "Google Ads is read-only. Studio runs SELECT and refuses a write.";
const ONE_STATEMENT = "Google Ads runs one statement. Remove the second statement.";
const NO_COUNT = "Google Ads has no COUNT(*). Select a metric, such as metrics.clicks.";

export type GoogleAdsType = "text" | "number" | "date";

export interface GoogleAdsColumn {
  readonly name: string;
  readonly type: GoogleAdsType;
}

export interface GoogleAdsResource {
  readonly name: string;
  readonly primary: string;
  readonly columns: readonly GoogleAdsColumn[];
}

export type GoogleAdsCompare = "=" | "!=" | "<>" | "<" | ">" | "<=" | ">=";

export interface GoogleAdsFilter {
  readonly field: string;
  readonly operator: GoogleAdsCompare | "LIKE" | "IS NULL" | "IS NOT NULL";
  readonly value: string;
}

export interface GoogleAdsOrder {
  readonly column: string;
  readonly desc: boolean;
}

export interface GoogleAdsSelect {
  readonly kind: "select";
  readonly resource: GoogleAdsResource;
  readonly columns: readonly string[] | null;
  readonly filters: readonly GoogleAdsFilter[];
  readonly orderBy: GoogleAdsOrder | null;
  readonly limit: number;
  readonly offset: number;
  readonly capped: boolean;
}

function column(name: string, type: GoogleAdsType): GoogleAdsColumn {
  return { name, type };
}

function resource(name: string, primary: string, columns: readonly GoogleAdsColumn[]): GoogleAdsResource {
  return { name, primary, columns };
}

/** The standard resources this connection reads. The names are Google Ads Query Language resources. */
export const GOOGLE_ADS_RESOURCES: readonly GoogleAdsResource[] = Object.freeze([
  resource("customer", "customer.id", [
    column("customer.id", "text"),
    column("customer.descriptive_name", "text"),
    column("customer.currency_code", "text"),
    column("customer.time_zone", "text"),
    column("customer.status", "text"),
  ]),
  resource("campaign", "campaign.id", [
    column("campaign.id", "text"),
    column("campaign.name", "text"),
    column("campaign.status", "text"),
    column("campaign.advertising_channel_type", "text"),
    column("metrics.impressions", "number"),
    column("metrics.clicks", "number"),
    column("metrics.cost_micros", "number"),
    column("metrics.ctr", "number"),
    column("segments.date", "date"),
  ]),
  resource("ad_group", "ad_group.id", [
    column("ad_group.id", "text"),
    column("ad_group.name", "text"),
    column("ad_group.status", "text"),
    column("campaign.id", "text"),
    column("metrics.impressions", "number"),
    column("metrics.clicks", "number"),
    column("metrics.cost_micros", "number"),
  ]),
  resource("ad_group_ad", "ad_group_ad.ad.id", [
    column("ad_group_ad.ad.id", "text"),
    column("ad_group_ad.status", "text"),
    column("campaign.id", "text"),
    column("ad_group.id", "text"),
    column("metrics.impressions", "number"),
    column("metrics.clicks", "number"),
  ]),
  resource("keyword_view", "ad_group_criterion.criterion_id", [
    column("ad_group_criterion.criterion_id", "text"),
    column("ad_group_criterion.keyword.text", "text"),
    column("ad_group_criterion.keyword.match_type", "text"),
    column("campaign.id", "text"),
    column("metrics.impressions", "number"),
    column("metrics.clicks", "number"),
    column("metrics.cost_micros", "number"),
  ]),
]);

export function googleAdsResource(name: string): GoogleAdsResource | undefined {
  const key = name.toLowerCase();
  return GOOGLE_ADS_RESOURCES.find((item) => item.name === key);
}

export function googleAdsColumn(table: GoogleAdsResource, name: string): GoogleAdsColumn | undefined {
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

  private take(): Token {
    const token = this.peek();
    this.index += 1;
    return token;
  }

  private word(expected?: string): string | null {
    const token = this.peek();
    if (token.t !== "word") return null;
    if (expected !== undefined && token.v.toUpperCase() !== expected) return null;
    this.index += 1;
    return token.v;
  }

  private name(): string {
    const token = this.take();
    if (token.t === "word" || token.t === "ident") return safeName(token.v, this.sql);
    fail("Write a field name.", this.sql);
  }

  parse(): GoogleAdsSelect {
    const first = this.word();
    if (first === null || first.toUpperCase() !== "SELECT") fail(READ_ONLY, this.sql);
    if (this.word("DISTINCT") !== null) fail("Google Ads reads one SELECT without DISTINCT.", this.sql);
    if (this.word("COUNT") !== null) fail(NO_COUNT, this.sql);
    return this.select();
  }

  private table(): GoogleAdsResource {
    if (this.word("FROM") === null) fail("Write FROM and one resource, such as campaign.", this.sql);
    const found = googleAdsResource(this.name());
    if (found === undefined) fail("Google Ads has no resource with that name.", this.sql);
    return found;
  }

  private field(table: GoogleAdsResource): GoogleAdsColumn {
    const written = this.name();
    const found = googleAdsColumn(table, written);
    if (found === undefined) fail(`Google Ads has no field named ${written} on ${table.name}.`, this.sql);
    return found;
  }

  private select(): GoogleAdsSelect {
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

  private known(table: GoogleAdsResource, written: string): string {
    const found = googleAdsColumn(table, written);
    if (found === undefined) fail(`Google Ads has no field named ${written} on ${table.name}.`, this.sql);
    return found.name;
  }

  private filters(table: GoogleAdsResource): GoogleAdsFilter[] {
    if (this.word("WHERE") === null) return [];
    const filters = [this.predicate(table)];
    while (this.word("AND") !== null) filters.push(this.predicate(table));
    if (this.word("OR") !== null) fail("Combine filters with AND. Google Ads does not read OR here.", this.sql);
    return filters;
  }

  private predicate(table: GoogleAdsResource): GoogleAdsFilter {
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
    const written = operator?.toUpperCase() === "LIKE" ? "LIKE" : (operator as GoogleAdsCompare);
    return { field: field.name, operator: written, value: this.literal(field, written) };
  }

  private literal(field: GoogleAdsColumn, operator: GoogleAdsCompare | "LIKE"): string {
    if (operator === "LIKE") {
      if (field.type !== "text") fail("LIKE applies to a text field.", this.sql);
      const token = this.take();
      if (token.t !== "string") fail("Write the LIKE pattern in quotes.", this.sql);
      return token.v;
    }
    const token = this.take();
    if (field.type === "text" || field.type === "date") {
      if (token.t !== "string") fail("Write that value in quotes.", this.sql);
      return token.v;
    }
    if (token.t !== "number" || !/^-?\d+(\.\d+)?$/.test(token.v)) fail("Write a number.", this.sql);
    return token.v;
  }

  private order(table: GoogleAdsResource): GoogleAdsOrder | null {
    if (this.word("ORDER") === null) return null;
    if (this.word("BY") === null) fail("Write ORDER BY and one field.", this.sql);
    const column = this.field(table).name;
    const desc = this.word("DESC") !== null;
    if (!desc) this.word("ASC");
    if (this.word(",") !== null) fail("Google Ads orders by one field.", this.sql);
    return { column, desc };
  }

  private page(): { limit: number; offset: number; capped: boolean } {
    let limit = DEFAULT_LIMIT;
    let capped = false;
    if (this.word("LIMIT") !== null) {
      const written = this.whole("Write LIMIT as a positive whole number.");
      if (written < 1) fail("Write LIMIT as a positive whole number.", this.sql);
      if (written > GOOGLE_ADS_ROW_CAP) {
        limit = GOOGLE_ADS_ROW_CAP;
        capped = true;
      } else limit = written;
    }
    let offset = 0;
    if (this.word("OFFSET") !== null) offset = this.whole("Write OFFSET as a whole number.");
    if (offset > 0 && offset + limit > GOOGLE_ADS_ROW_CAP) capped = true;
    return { limit, offset, capped };
  }

  private whole(message: string): number {
    const token = this.take();
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
export function translateGoogleAdsSql(sql: string): GoogleAdsSelect {
  const text = sql.trim();
  if (text === "") fail("Write a SELECT.", sql);
  return new Parser(tokenize(text), text).parse();
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

function quote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function realDay(value: string): boolean {
  const day = DAY.exec(value);
  if (day === null) return false;
  const year = Number(day[1]);
  const month = Number(day[2]);
  const date = Number(day[3]);
  if (month < 1 || month > 12 || date < 1) return false;
  const parsed = new Date(Date.UTC(year, month - 1, date));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === date;
}

function gaqlValue(field: GoogleAdsColumn, value: string, operator: GoogleAdsFilter["operator"], sql: string): string {
  if (operator === "IS NULL" || operator === "IS NOT NULL") return "";
  if (field.type === "date") {
    if (!realDay(value)) fail("Write a real date, as 2026-01-31.", sql);
    return quote(value);
  }
  if (field.type === "number") return value;
  return quote(value);
}

function filterText(table: GoogleAdsResource, filter: GoogleAdsFilter, sql: string): string {
  const field = googleAdsColumn(table, filter.field);
  if (field === undefined) fail(`Google Ads has no field named ${filter.field} on ${table.name}.`, sql);
  if (filter.operator === "IS NULL") return `${field.name} IS NULL`;
  if (filter.operator === "IS NOT NULL") return `${field.name} IS NOT NULL`;
  const op = filter.operator === "<>" ? "!=" : filter.operator;
  return `${field.name} ${op} ${gaqlValue(field, filter.value, filter.operator, sql)}`;
}

/** The Google Ads Query Language for one translated statement. The API has no OFFSET, so the caller slices. */
function selectedName(table: GoogleAdsResource, name: string, sql: string): string {
  const found = googleAdsColumn(table, name);
  if (found === undefined) fail(`Google Ads has no field named ${name} on ${table.name}.`, sql);
  return found.name;
}

export function googleAdsQuery(statement: GoogleAdsSelect, sql: string): string {
  const selected =
    statement.columns === null
      ? statement.resource.columns.map((item) => item.name)
      : statement.columns.map((name) => selectedName(statement.resource, name, sql));
  const filters = statement.filters.map((item) => filterText(statement.resource, item, sql));
  const where = filters.length === 0 ? "" : ` WHERE ${filters.join(" AND ")}`;
  const order =
    statement.orderBy === null ? "" : ` ORDER BY ${statement.orderBy.column}${statement.orderBy.desc ? " DESC" : ""}`;
  const fetch = Math.min(statement.offset + statement.limit, GOOGLE_ADS_ROW_CAP);
  return `SELECT ${selected.join(", ")} FROM ${statement.resource.name}${where}${order} LIMIT ${fetch}`;
}
