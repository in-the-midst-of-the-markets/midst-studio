/**
 * The SQL subset an Intercom connection runs.
 *
 * Intercom has no SQL engine. The editor still speaks SQL, and this module turns one
 * SELECT into one list or one search: a filter, an order and a page. A write, a join
 * and a second statement fail here, before a request.
 */
import { QueryError } from "@/lib/db/errors";

const PROVIDER = "intercom" as const;

export const INTERCOM_ROW_CAP = 1000;
export const INTERCOM_PAGE_SIZE = 50;
const DEFAULT_LIMIT = 100;

export type IntercomType = "text" | "time" | "bool" | "number";

export interface IntercomColumn {
  readonly name: string;
  readonly type: IntercomType;
}

export interface IntercomEntity {
  readonly name: string;
  readonly path: string;
  readonly responseKey: string;
  readonly paging: "cursor" | "all";
  readonly search: string | null;
  readonly primary: string;
  readonly columns: readonly IntercomColumn[];
}

export type IntercomOperator = "=" | "!=" | "<" | "<=" | ">" | ">=" | "^" | "$" | "~";

export interface IntercomFilter {
  readonly field: string;
  readonly operator: IntercomOperator;
  readonly value: string | number | boolean;
}

export interface IntercomOrder {
  readonly column: string;
  readonly desc: boolean;
}

export interface IntercomSelect {
  readonly kind: "select";
  readonly entity: string;
  readonly columns: readonly string[] | null;
  readonly filters: readonly IntercomFilter[];
  readonly orderBy: IntercomOrder | null;
  readonly limit: number;
  readonly offset: number;
  readonly capped: boolean;
}

export interface IntercomCount {
  readonly kind: "count";
  readonly entity: string;
  readonly filters: readonly IntercomFilter[];
}

export type IntercomStatement = IntercomSelect | IntercomCount;

const TEXT = "text" as const;
const TIME = "time" as const;
const BOOL = "bool" as const;
const NUM = "number" as const;

function columns(fields: readonly (readonly [string, IntercomType])[]): IntercomColumn[] {
  return fields.map(([name, type]) => ({ name, type }));
}

function list(
  name: string,
  paging: "cursor" | "all",
  responseKey: string,
  search: string | null,
  fields: readonly (readonly [string, IntercomType])[],
): IntercomEntity {
  const defined = columns(fields);
  const head = defined[0] as IntercomColumn;
  return {
    name,
    path: name.toLowerCase(),
    responseKey,
    paging,
    search,
    primary: head.name,
    columns: defined,
  };
}

/** The lists the object tree shows, in the spelling the REST API wants. */
export const INTERCOM_ENTITIES: readonly IntercomEntity[] = Object.freeze([
  list("Contacts", "cursor", "data", "contacts/search", [
    ["id", TEXT],
    ["role", TEXT],
    ["email", TEXT],
    ["name", TEXT],
    ["phone", TEXT],
    ["external_id", TEXT],
    ["created_at", TIME],
    ["updated_at", TIME],
    ["signed_up_at", TIME],
    ["last_seen_at", TIME],
    ["owner_id", NUM],
    ["unsubscribed_from_emails", BOOL],
  ]),
  list("Conversations", "cursor", "conversations", "conversations/search", [
    ["id", TEXT],
    ["state", TEXT],
    ["open", BOOL],
    ["read", BOOL],
    ["priority", TEXT],
    ["created_at", TIME],
    ["updated_at", TIME],
    ["waiting_since", TIME],
    ["snoozed_until", TIME],
    ["admin_assignee_id", NUM],
    ["team_assignee_id", NUM],
    ["source.type", TEXT],
    ["source.delivered_as", TEXT],
    ["source.subject", TEXT],
  ]),
  list("Admins", "all", "admins", null, [
    ["id", TEXT],
    ["name", TEXT],
    ["email", TEXT],
    ["job_title", TEXT],
    ["away_mode_enabled", BOOL],
  ]),
  list("Tags", "all", "data", null, [
    ["id", TEXT],
    ["name", TEXT],
  ]),
  list("Segments", "all", "segments", null, [
    ["id", TEXT],
    ["name", TEXT],
    ["type", TEXT],
  ]),
  list("Teams", "all", "teams", null, [
    ["id", TEXT],
    ["name", TEXT],
  ]),
]);

const ENTITY_BY_NAME = new Map(INTERCOM_ENTITIES.map((entity) => [entity.name.toLowerCase(), entity]));

/** The catalog list, or null when the name is not one this connection shows. */
export function intercomEntity(name: string): IntercomEntity | null {
  return ENTITY_BY_NAME.get(name.toLowerCase()) ?? null;
}

function columnOf(entity: IntercomEntity, name: string): IntercomColumn | null {
  const found = entity.columns.find((column) => column.name.toLowerCase() === name.toLowerCase());
  return found ?? null;
}

type Token =
  | { readonly t: "word"; readonly v: string }
  | { readonly t: "ident"; readonly v: string }
  | { readonly t: "string"; readonly v: string }
  | { readonly t: "number"; readonly v: number }
  | { readonly t: "star" }
  | { readonly t: "comma" }
  | { readonly t: "lparen" }
  | { readonly t: "rparen" }
  | { readonly t: "eof" };

const READ_ONLY = "Intercom SQL is read-only. Write a SELECT.";
const ONE_STATEMENT = "Intercom runs one statement.";
const ONE_ENTITY = "Intercom reads one list. Join the result in another connection.";
const AND_ONLY = "Intercom combines filters with AND.";
const FIELD_MESSAGE = "Intercom has no field with that name.";
const DATE_MESSAGE = "Write a date as YYYY-MM-DD.";
const NUMBER_MESSAGE = "Write a number for that field.";
const BOOLEAN_MESSAGE = "Write true or false for that field.";
const TEXT_MESSAGE = "Write that field's value in quotes.";
const LIKE_MESSAGE = "LIKE supports a prefix (abc%), a suffix (%abc), or a contains (%abc%).";
const LIKE_TEXT = "LIKE applies to a text field.";

function fail(message: string, sql: string): never {
  throw new QueryError(message, PROVIDER, sql);
}

function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const length = sql.length;
  while (i < length) {
    const c = sql[i] ?? "";
    if (c === " " || c === "\n" || c === "\t" || c === "\r") {
      i += 1;
      continue;
    }
    if (c === "-" && sql[i + 1] === "-") {
      i += 2;
      while (i < length && sql[i] !== "\n") i += 1;
      continue;
    }
    if (c === "-" && (sql[i + 1] ?? "") >= "0" && (sql[i + 1] ?? "") <= "9") {
      i += 1;
      const number = readNumber(sql, i);
      tokens.push({ t: "number", v: -number.value });
      i = number.end;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end < 0) fail("Intercom could not read that statement.", sql);
      i = end + 2;
      continue;
    }
    if (c === "'") {
      let value = "";
      i += 1;
      let closed = false;
      while (i < length) {
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
      if (!closed) fail("Intercom could not read that statement.", sql);
      tokens.push({ t: "string", v: value });
      continue;
    }
    if (c === '"') {
      let value = "";
      i += 1;
      let closed = false;
      while (i < length) {
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
      if (!closed) fail("Intercom could not read that statement.", sql);
      tokens.push({ t: "ident", v: value });
      continue;
    }
    if (c === "*") {
      tokens.push({ t: "star" });
      i += 1;
      continue;
    }
    if (c === ",") {
      tokens.push({ t: "comma" });
      i += 1;
      continue;
    }
    if (c === "(") {
      tokens.push({ t: "lparen" });
      i += 1;
      continue;
    }
    if (c === ")") {
      tokens.push({ t: "rparen" });
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
      tokens.push({ t: "word", v: c });
      i += 1;
      continue;
    }
    if (c === ";") {
      const rest = sql.slice(i + 1).trim();
      if (rest !== "") fail(ONE_STATEMENT, sql);
      break;
    }
    if (c >= "0" && c <= "9") {
      const number = readNumber(sql, i);
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

function readNumber(sql: string, start: number): { value: number; end: number } {
  let i = start;
  let raw = "";
  while (i < sql.length && (sql[i] ?? "") >= "0" && (sql[i] ?? "") <= "9") {
    raw += sql[i];
    i += 1;
  }
  if (sql[i] === "." && (sql[i + 1] ?? "") >= "0" && (sql[i + 1] ?? "") <= "9") {
    raw += ".";
    i += 1;
    while (i < sql.length && (sql[i] ?? "") >= "0" && (sql[i] ?? "") <= "9") {
      raw += sql[i];
      i += 1;
    }
  }
  return { value: Number(raw), end: i };
}

const SAFE_NAME = /^[A-Za-z][A-Za-z0-9_.]*$/;

function safeName(name: string, sql: string): string {
  if (name.length > 80 || !SAFE_NAME.test(name)) fail("Write a field name without spaces or punctuation.", sql);
  return name;
}

interface Literal {
  readonly kind: "string" | "number" | "boolean";
  readonly value: string;
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

  parse(): IntercomStatement {
    const first = this.word();
    if (first === null || first.toUpperCase() !== "SELECT") fail(READ_ONLY, this.sql);
    if (this.word("DISTINCT") !== null) fail("Intercom reads one SELECT without DISTINCT.", this.sql);
    if (this.word("COUNT") !== null) return this.count();
    return this.select();
  }

  private entity(): IntercomEntity {
    if (this.word("FROM") === null) fail("Write FROM and a list, such as Contacts.", this.sql);
    const table = this.name();
    if (this.word("JOIN") !== null) fail(ONE_ENTITY, this.sql);
    const found = intercomEntity(table);
    if (found === null) fail("Intercom has no table with that name.", this.sql);
    return found;
  }

  private known(entity: IntercomEntity, name: string): IntercomColumn {
    const column = columnOf(entity, name);
    if (column === null) fail(FIELD_MESSAGE, this.sql);
    return column;
  }

  private literal(): Literal {
    const token = this.peek();
    if (token.t === "string") {
      this.take();
      return { kind: "string", value: token.v };
    }
    if (token.t === "number") {
      this.take();
      return { kind: "number", value: String(token.v) };
    }
    if (token.t === "word" && (token.v.toUpperCase() === "TRUE" || token.v.toUpperCase() === "FALSE")) {
      this.take();
      return { kind: "boolean", value: token.v.toLowerCase() };
    }
    fail("Write the value in quotes, as a number, or as true or false.", this.sql);
  }

  private comparison(column: IntercomColumn, op: "=" | "!=" | "<" | ">" | "<=" | ">="): IntercomFilter {
    return { field: column.name, operator: op, value: this.typed(column, this.literal()) };
  }

  private typed(column: IntercomColumn, literal: Literal): string | number | boolean {
    if (column.type === "number") {
      if (literal.kind !== "number") fail(NUMBER_MESSAGE, this.sql);
      return Number(literal.value);
    }
    if (column.type === "bool") {
      if (literal.kind !== "boolean") fail(BOOLEAN_MESSAGE, this.sql);
      return literal.value === "true";
    }
    if (column.type === "time") {
      if (literal.kind === "number") return Number(literal.value);
      if (literal.kind !== "string") fail(DATE_MESSAGE, this.sql);
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(literal.value);
      if (match === null) fail(DATE_MESSAGE, this.sql);
      const year = Number(match[1]);
      const month = Number(match[2]);
      const day = Number(match[3]);
      if (month < 1 || month > 12 || day < 1 || day > 31) fail(DATE_MESSAGE, this.sql);
      return Math.floor(Date.UTC(year, month - 1, day) / 1000);
    }
    if (literal.kind !== "string") fail(TEXT_MESSAGE, this.sql);
    if (/[\r\n\u0000]/.test(literal.value)) fail("Write the value on one line.", this.sql);
    return literal.value;
  }

  private like(column: IntercomColumn): IntercomFilter {
    if (column.type !== "text") fail(LIKE_TEXT, this.sql);
    const token = this.peek();
    if (token.t !== "string") fail("Write LIKE with a quoted value.", this.sql);
    const literal = this.literal();
    const raw = literal.value;
    const starts = raw.startsWith("%");
    const ends = raw.endsWith("%");
    const inner = raw.slice(starts ? 1 : 0, ends ? raw.length - 1 : raw.length);
    if (inner.includes("%")) fail(LIKE_MESSAGE, this.sql);
    if ((starts || ends) && inner === "") fail("Write a value inside the percent signs.", this.sql);
    if (/[\r\n\u0000]/.test(inner)) fail("Write the value on one line.", this.sql);
    if (starts && ends) return { field: column.name, operator: "~", value: inner };
    if (ends) return { field: column.name, operator: "^", value: inner };
    if (starts) return { field: column.name, operator: "$", value: inner };
    return { field: column.name, operator: "=", value: inner };
  }

  private filter(entity: IntercomEntity): IntercomFilter {
    const column = this.known(entity, this.name());
    if (this.word("IN") !== null) fail("Intercom has no IN filter. Compare the field, or use LIKE.", this.sql);
    if (this.word("LIKE") !== null) return this.like(column);
    const op = this.word();
    if (op === "=" || op === "!=" || op === "<>" || op === "<" || op === ">" || op === "<=" || op === ">=") {
      return this.comparison(column, op === "<>" ? "!=" : op);
    }
    if (op !== null && op.toUpperCase() === "OR") fail(AND_ONLY, this.sql);
    fail("Intercom filters with =, !=, <, >, <=, >=, or LIKE.", this.sql);
  }

  private where(entity: IntercomEntity): IntercomFilter[] {
    if (this.word("WHERE") === null) return [];
    const filters: IntercomFilter[] = [];
    for (;;) {
      filters.push(this.filter(entity));
      if (this.word("OR") !== null) fail(AND_ONLY, this.sql);
      if (this.word("AND") === null) break;
    }
    return filters;
  }

  private orderBy(entity: IntercomEntity): IntercomOrder | null {
    if (this.word("ORDER") === null) return null;
    if (this.word("BY") === null) fail("Write ORDER BY and a field.", this.sql);
    const column = this.known(entity, this.name());
    const direction = this.word();
    const desc = direction !== null && direction.toUpperCase() === "DESC";
    if (direction !== null && !desc && direction.toUpperCase() !== "ASC") this.index -= 1;
    if (this.peek().t === "comma") fail("Intercom orders by one field.", this.sql);
    return { column: column.name, desc };
  }

  private takeLimit(): { limit: number; capped: boolean } {
    const token = this.take();
    if (token.t !== "number" || !Number.isInteger(token.v) || token.v < 1) {
      fail("Write LIMIT as a whole number greater than zero.", this.sql);
    }
    return { limit: token.v > INTERCOM_ROW_CAP ? INTERCOM_ROW_CAP : token.v, capped: token.v > INTERCOM_ROW_CAP };
  }

  private takeOffset(): number {
    const token = this.take();
    if (token.t !== "number" || !Number.isInteger(token.v) || token.v < 0) {
      fail("Write OFFSET as a whole number.", this.sql);
    }
    return token.v;
  }

  private limit(): { limit: number; offset: number; capped: boolean } {
    let limit = DEFAULT_LIMIT;
    let offset = 0;
    let capped = false;
    if (this.word("LIMIT") !== null) {
      ({ limit, capped } = this.takeLimit());
      if (this.word("OFFSET") !== null) offset = this.takeOffset();
    } else if (this.word("OFFSET") !== null) {
      offset = this.takeOffset();
      if (this.word("LIMIT") !== null) ({ limit, capped } = this.takeLimit());
    }
    return { limit, offset, capped };
  }

  private finish(): void {
    if (this.peek().t !== "eof") fail(READ_ONLY, this.sql);
  }

  private select(): IntercomSelect {
    const requested = this.columns();
    const entity = this.entity();
    const selected = requested === null ? null : requested.map((name) => this.known(entity, name).name);
    const filters = this.where(entity);
    const orderBy = this.orderBy(entity);
    const window = this.limit();
    this.finish();
    return { kind: "select", entity: entity.name, columns: selected, filters, orderBy, ...window };
  }

  private columns(): readonly string[] | null {
    if (this.peek().t === "star") {
      this.take();
      if (this.peek().t === "comma") fail("Write * on its own.", this.sql);
      return null;
    }
    const names: string[] = [];
    for (;;) {
      if (this.peek().t === "star") fail("Write * on its own.", this.sql);
      names.push(this.name());
      if (this.peek().t !== "comma") break;
      this.take();
    }
    return names;
  }

  private count(): IntercomCount {
    if (this.peek().t !== "lparen") fail("Write COUNT(*).", this.sql);
    this.take();
    if (this.peek().t !== "star") fail("Write COUNT(*).", this.sql);
    this.take();
    if (this.peek().t !== "rparen") fail("Write COUNT(*).", this.sql);
    this.take();
    if (this.word("AS") !== null) this.name();
    const entity = this.entity();
    const filters = this.where(entity);
    if (this.word("ORDER") !== null) fail("COUNT(*) does not take ORDER BY.", this.sql);
    if (this.word("LIMIT") !== null || this.word("OFFSET") !== null) {
      fail("COUNT(*) does not take LIMIT or OFFSET.", this.sql);
    }
    this.finish();
    return { kind: "count", entity: entity.name, filters };
  }
}

/** One statement. The provider sends it as one list or one search after this returns. */
export function translateIntercomSql(sql: string): IntercomStatement {
  const trimmed = sql.trim();
  if (trimmed === "") fail(READ_ONLY, sql);
  return new Parser(tokenize(trimmed), sql).parse();
}

/** The catalog list for one statement. A missing name is a query error. */
export function intercomQuery(statement: IntercomStatement): IntercomEntity {
  const entity = intercomEntity(statement.entity);
  if (entity === null) fail("Intercom has no table with that name.", statement.entity);
  return entity;
}
