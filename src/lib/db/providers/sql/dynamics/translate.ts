/**
 * The SQL subset a Microsoft Dynamics connection runs.
 *
 * Dynamics 365 is a Dataverse Web API, not a SQL server. The editor still speaks SQL, and this
 * module turns one SELECT into one OData read of one standard table: a filter, an order and a
 * page. A write, a join and a second statement fail here, before a request. Custom tables,
 * Finance and Operations, and Business Central are not this connection.
 */
import { QueryError } from "@/lib/db/errors";

const PROVIDER = "dynamics" as const;

export const DYNAMICS_ROW_CAP = 1000;
const DEFAULT_LIMIT = 100;
const READ_ONLY = "Dynamics is read-only. Studio runs SELECT and COUNT(*) and refuses a write.";
const ONE_STATEMENT = "Dynamics runs one statement. Remove the second statement.";

export type DynamicsType = "guid" | "text" | "number" | "bool" | "time";

export interface DynamicsColumn {
  readonly name: string;
  /** The Web API property. A lookup's SQL name is the logical name; this is `_logicalname_value`. */
  readonly select: string;
  readonly type: DynamicsType;
}

export interface DynamicsEntity {
  readonly name: string;
  readonly set: string;
  readonly primary: string;
  readonly columns: readonly DynamicsColumn[];
}

export type DynamicsCompare = "=" | "!=" | "<>" | "<" | ">" | "<=" | ">=";

export interface DynamicsFilter {
  readonly field: string;
  readonly operator: DynamicsCompare | "LIKE" | "IS NULL" | "IS NOT NULL";
  readonly value: string;
}

export interface DynamicsOrder {
  readonly column: string;
  readonly desc: boolean;
}

export interface DynamicsSelect {
  readonly kind: "select";
  readonly entity: DynamicsEntity;
  readonly columns: readonly string[] | null;
  readonly filters: readonly DynamicsFilter[];
  readonly orderBy: DynamicsOrder | null;
  readonly limit: number;
  readonly offset: number;
  readonly capped: boolean;
}

export interface DynamicsCount {
  readonly kind: "count";
  readonly entity: DynamicsEntity;
  readonly alias: string;
  readonly filters: readonly DynamicsFilter[];
}

export type DynamicsStatement = DynamicsSelect | DynamicsCount;

interface Literal {
  readonly kind: "string" | "number" | "boolean";
  readonly value: string;
}

function column(name: string, type: DynamicsType, select = name): DynamicsColumn {
  return { name, select, type };
}

function entity(name: string, primary: string, columns: readonly DynamicsColumn[]): DynamicsEntity {
  return { name, set: name, primary, columns };
}

/** The standard Dataverse tables this connection reads. The names are the Web API entity sets. */
export const DYNAMICS_ENTITIES: readonly DynamicsEntity[] = Object.freeze([
  entity("accounts", "accountid", [
    column("accountid", "guid"),
    column("name", "text"),
    column("accountnumber", "text"),
    column("telephone1", "text"),
    column("emailaddress1", "text"),
    column("websiteurl", "text"),
    column("address1_city", "text"),
    column("address1_country", "text"),
    column("revenue", "number"),
    column("numberofemployees", "number"),
    column("statecode", "number"),
    column("createdon", "time"),
    column("modifiedon", "time"),
  ]),
  entity("contacts", "contactid", [
    column("contactid", "guid"),
    column("fullname", "text"),
    column("firstname", "text"),
    column("lastname", "text"),
    column("emailaddress1", "text"),
    column("telephone1", "text"),
    column("jobtitle", "text"),
    column("address1_city", "text"),
    column("statecode", "number"),
    column("createdon", "time"),
    column("parentcustomerid", "guid", "_parentcustomerid_value"),
  ]),
  entity("leads", "leadid", [
    column("leadid", "guid"),
    column("subject", "text"),
    column("fullname", "text"),
    column("companyname", "text"),
    column("emailaddress1", "text"),
    column("telephone1", "text"),
    column("statecode", "number"),
    column("createdon", "time"),
  ]),
  entity("opportunities", "opportunityid", [
    column("opportunityid", "guid"),
    column("name", "text"),
    column("estimatedvalue", "number"),
    column("estimatedclosedate", "time"),
    column("closeprobability", "number"),
    column("statecode", "number"),
    column("createdon", "time"),
    column("customerid", "guid", "_customerid_value"),
  ]),
  entity("systemusers", "systemuserid", [
    column("systemuserid", "guid"),
    column("fullname", "text"),
    column("internalemailaddress", "text"),
    column("title", "text"),
    column("isdisabled", "bool"),
  ]),
  entity("tasks", "activityid", [
    column("activityid", "guid"),
    column("subject", "text"),
    column("scheduledend", "time"),
    column("statecode", "number"),
    column("prioritycode", "number"),
    column("createdon", "time"),
    column("regardingobjectid", "guid", "_regardingobjectid_value"),
  ]),
  entity("incidents", "incidentid", [
    column("incidentid", "guid"),
    column("title", "text"),
    column("ticketnumber", "text"),
    column("prioritycode", "number"),
    column("statecode", "number"),
    column("createdon", "time"),
    column("customerid", "guid", "_customerid_value"),
  ]),
]);

export function dynamicsEntity(name: string): DynamicsEntity | undefined {
  return DYNAMICS_ENTITIES.find((item) => item.name.toLowerCase() === name.toLowerCase());
}

export function dynamicsColumn(table: DynamicsEntity, name: string): DynamicsColumn | undefined {
  return table.columns.find((item) => item.name.toLowerCase() === name.toLowerCase());
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

  parse(): DynamicsStatement {
    const first = this.word();
    if (first === null || first.toUpperCase() !== "SELECT") fail(READ_ONLY, this.sql);
    if (this.word("DISTINCT") !== null) fail("Dynamics reads one SELECT without DISTINCT.", this.sql);
    if (this.word("COUNT") !== null) return this.count();
    return this.select();
  }

  private table(): DynamicsEntity {
    if (this.word("FROM") === null) fail("Write FROM and one table, such as accounts.", this.sql);
    const found = dynamicsEntity(this.name());
    if (found === undefined) fail("Dynamics has no table with that name.", this.sql);
    return found;
  }

  private field(table: DynamicsEntity): DynamicsColumn {
    const written = this.name();
    const found = dynamicsColumn(table, written);
    if (found === undefined) fail(`Dynamics has no field named ${written} on ${table.name}.`, this.sql);
    return found;
  }

  private count(): DynamicsCount {
    if (this.word("(") === null || this.word("*") === null || this.word(")") === null) {
      fail("Write COUNT(*) to count rows.", this.sql);
    }
    let alias = "totalCount";
    if (this.word("AS") !== null) alias = this.name();
    const table = this.table();
    const filters = this.filters(table);
    if (this.word("ORDER") !== null || this.word("LIMIT") !== null || this.word("OFFSET") !== null) {
      fail("COUNT(*) takes a WHERE filter and no page.", this.sql);
    }
    this.end();
    return { kind: "count", entity: table, alias, filters };
  }

  private select(): DynamicsSelect {
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
    return { kind: "select", entity: table, columns, filters, orderBy, ...page };
  }

  private known(table: DynamicsEntity, written: string): string {
    const found = dynamicsColumn(table, written);
    if (found === undefined) fail(`Dynamics has no field named ${written} on ${table.name}.`, this.sql);
    return found.name;
  }

  private filters(table: DynamicsEntity): DynamicsFilter[] {
    if (this.word("WHERE") === null) return [];
    const filters = [this.predicate(table)];
    while (this.word("AND") !== null) filters.push(this.predicate(table));
    if (this.word("OR") !== null) fail("Combine filters with AND. Dynamics does not read OR here.", this.sql);
    return filters;
  }

  private predicate(table: DynamicsEntity): DynamicsFilter {
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
    const written = operator?.toUpperCase() === "LIKE" ? "LIKE" : (operator as DynamicsCompare);
    return { field: field.name, operator: written, value: this.literal(field, written) };
  }

  private literal(field: DynamicsColumn, operator: DynamicsCompare | "LIKE"): string {
    if (operator === "LIKE") {
      if (field.type !== "text") fail("LIKE applies to a text field.", this.sql);
      const token = this.take();
      if (token.t !== "string") fail("Write the LIKE pattern in quotes.", this.sql);
      return token.v;
    }
    const token = this.take();
    if (field.type === "text" || field.type === "guid" || field.type === "time") {
      if (token.t !== "string") fail("Write that value in quotes.", this.sql);
      return token.v;
    }
    if (field.type === "bool") {
      if (token.t !== "word" || (token.v.toUpperCase() !== "TRUE" && token.v.toUpperCase() !== "FALSE")) {
        fail("Write true or false.", this.sql);
      }
      return token.v.toLowerCase();
    }
    if (token.t !== "number" || !/^-?\d+(\.\d+)?$/.test(token.v)) fail("Write a number.", this.sql);
    return token.v;
  }

  private order(table: DynamicsEntity): DynamicsOrder | null {
    if (this.word("ORDER") === null) return null;
    if (this.word("BY") === null) fail("Write ORDER BY and one field.", this.sql);
    const column = this.field(table).name;
    const desc = this.word("DESC") !== null;
    if (!desc) this.word("ASC");
    if (this.word(",") !== null) fail("Dynamics orders by one field.", this.sql);
    return { column, desc };
  }

  private page(): { limit: number; offset: number; capped: boolean } {
    let limit = DEFAULT_LIMIT;
    let capped = false;
    if (this.word("LIMIT") !== null) {
      const written = this.whole("Write LIMIT as a positive whole number.");
      if (written < 1) fail("Write LIMIT as a positive whole number.", this.sql);
      if (written > DYNAMICS_ROW_CAP) {
        limit = DYNAMICS_ROW_CAP;
        capped = true;
      } else limit = written;
    }
    let offset = 0;
    if (this.word("OFFSET") !== null) offset = this.whole("Write OFFSET as a whole number.");
    if (offset > 0 && offset + limit > DYNAMICS_ROW_CAP) capped = true;
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
export function translateDynamicsSql(sql: string): DynamicsStatement {
  const text = sql.trim();
  if (text === "") fail("Write a SELECT.", sql);
  return new Parser(tokenize(text), text).parse();
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,7}))?Z$/;

function quote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function dateParts(year: number, month: number, day: number, hour: number, minute: number, second: number): boolean {
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** A date literal Dataverse accepts unquoted, or a refusal. */
export function dynamicsTimeLiteral(value: string, sql: string): string {
  const day = DAY.exec(value);
  if (day !== null) {
    const year = Number(day[1]);
    const month = Number(day[2]);
    const date = Number(day[3]);
    if (!dateParts(year, month, date, 0, 0, 0)) fail("Write a real date, as 2026-01-31 or 2026-01-31T00:00:00Z.", sql);
    return `${value}T00:00:00Z`;
  }
  const instant = INSTANT.exec(value);
  if (instant === null) fail("Write a real date, as 2026-01-31 or 2026-01-31T00:00:00Z.", sql);
  const year = Number(instant[1]);
  const month = Number(instant[2]);
  const date = Number(instant[3]);
  const hour = Number(instant[4]);
  const minute = Number(instant[5]);
  const second = Number(instant[6]);
  if (!dateParts(year, month, date, hour, minute, second)) {
    fail("Write a real date, as 2026-01-31 or 2026-01-31T00:00:00Z.", sql);
  }
  return value;
}

function odataValue(field: DynamicsColumn, value: string, operator: DynamicsFilter["operator"], sql: string): string {
  if (operator === "IS NULL" || operator === "IS NOT NULL") return "";
  if (operator === "LIKE") {
    if (
      value.includes("_") ||
      value.slice(value.startsWith("%") ? 1 : 0, value.endsWith("%") ? -1 : undefined).includes("%")
    ) {
      fail("Write a LIKE pattern with % only at the start or the end.", sql);
    }
    return "";
  }
  if (field.type === "text") return quote(value);
  if (field.type === "number") return value;
  if (field.type === "bool") return value;
  if (field.type === "guid") {
    if (!GUID.test(value)) fail("Write a GUID in quotes.", sql);
    return value.toLowerCase();
  }
  return dynamicsTimeLiteral(value, sql);
}

function likeCall(property: string, pattern: string): string {
  const starts = pattern.startsWith("%");
  const ends = pattern.endsWith("%");
  const core = pattern.slice(starts ? 1 : 0, ends && pattern.length > (starts ? 1 : 0) ? -1 : undefined);
  const text = quote(core);
  if (starts && ends) return `contains(${property},${text})`;
  if (ends) return `startswith(${property},${text})`;
  if (starts) return `endswith(${property},${text})`;
  return `${property} eq ${text}`;
}

function filterText(table: DynamicsEntity, filter: DynamicsFilter, sql: string): string {
  const field = dynamicsColumn(table, filter.field);
  if (field === undefined) fail(`Dynamics has no field named ${filter.field} on ${table.name}.`, sql);
  const property = field.select;
  if (filter.operator === "IS NULL") return `${property} eq null`;
  if (filter.operator === "IS NOT NULL") return `${property} ne null`;
  if (filter.operator === "LIKE") {
    odataValue(field, filter.value, filter.operator, sql);
    return likeCall(property, filter.value);
  }
  const op = { "=": "eq", "!=": "ne", "<>": "ne", "<": "lt", ">": "gt", "<=": "le", ">=": "ge" }[filter.operator];
  return `${property} ${op} ${odataValue(field, filter.value, filter.operator, sql)}`;
}

/** The Web API path and query for one translated statement. `$filter` is unencoded OData text. */
export function dynamicsOData(statement: DynamicsStatement, sql: string): { path: string; params: URLSearchParams } {
  const params = new URLSearchParams();
  const filter = statement.filters.map((item) => filterText(statement.entity, item, sql)).join(" and ");
  if (filter !== "") params.set("$filter", filter);
  if (statement.kind === "count") return { path: `/api/data/v9.2/${statement.entity.set}/$count`, params };
  const selected =
    statement.columns === null
      ? statement.entity.columns
      : statement.columns.map((name) => dynamicsColumn(statement.entity, name) as DynamicsColumn);
  params.set("$select", selected.map((item) => item.select).join(","));
  if (statement.orderBy !== null) {
    const column = dynamicsColumn(statement.entity, statement.orderBy.column) as DynamicsColumn;
    params.set("$orderby", `${column.select} ${statement.orderBy.desc ? "desc" : "asc"}`);
  }
  params.set("$top", String(statement.limit));
  if (statement.offset > 0) params.set("$skip", String(statement.offset));
  return { path: `/api/data/v9.2/${statement.entity.set}`, params };
}
