/**
 * What one Stripe statement asks for.
 *
 * A query is Sigma SQL (`SELECT` or `WITH`) and is sent unchanged, apart from one trailing
 * semicolon. A report is a report template. A report preview is the statement a click on a
 * report writes (`SELECT * FROM "reports"."name"`), which runs that report rather than SQL.
 */
import { QueryError } from "@/lib/db/errors";

const PROVIDER = "stripe" as const;

export interface StripeQuery {
  readonly kind: "query";
  readonly sql: string;
}

export interface StripeReport {
  readonly kind: "report";
  readonly name: string;
  readonly parameters: Readonly<Record<string, string | number | boolean>>;
}

export interface StripeReportPreview {
  readonly kind: "report-preview";
  readonly name: string;
}

export type StripeStatement = StripeQuery | StripeReport | StripeReportPreview;

const READ_ONLY = "Stripe runs a SELECT or WITH query, or a REPORT. This connection is read-only.";
const ONE_STATEMENT = "Stripe runs one statement at a time.";
const UNREADABLE = "Stripe could not read that statement.";
const REPORT_NAME = "A report name is the template's name, such as balance.summary.";

/**
 * The statement Studio will send. The SQL text of a query is the text Stripe runs, so it is
 * not rewritten into another dialect.
 */
export function prepareStripeStatement(sql: string): StripeStatement {
  const body = stripTrailingSemicolon(sql);
  if (body.trim() === "") throw new QueryError(READ_ONLY, PROVIDER, sql);
  if (hasAnotherStatement(body)) throw new QueryError(ONE_STATEMENT, PROVIDER, sql);
  const preview = reportPreview(body);
  if (preview !== undefined) return preview;
  const keyword = leadingWord(body);
  if (keyword === "REPORT") return parseReport(body, sql);
  if (keyword === "SELECT" || keyword === "WITH") return { kind: "query", sql: body.trim() };
  throw new QueryError(READ_ONLY, PROVIDER, sql);
}

function stripTrailingSemicolon(sql: string): string {
  const trimmed = sql.trim();
  return trimmed.endsWith(";") ? trimmed.slice(0, -1).trimEnd() : trimmed;
}

/** A click on a report, plus the row cap the shared limiter may append. */
function reportPreview(sql: string): StripeReportPreview | undefined {
  const match =
    /^SELECT\s+\*\s+FROM\s+"reports"\s*\.\s*"((?:[^"]|"")*)"(?:\s+LIMIT\s+\d+)?(?:\s+OFFSET\s+\d+)?\s*$/i.exec(
      sql.trim(),
    );
  if (match === null) return undefined;
  const name = (match[1] ?? "").replaceAll('""', '"').trim();
  if (name === "") throw new QueryError(REPORT_NAME, PROVIDER, sql);
  return { kind: "report-preview", name };
}

function parseReport(sql: string, original: string): StripeReport {
  const match = /^REPORT\s+([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\s*(\([\s\S]*\))?\s*$/i.exec(
    sql.trim(),
  );
  if (match === null) throw new QueryError(REPORT_NAME, PROVIDER, original);
  const name = match[1] ?? "";
  const group = match[2];
  if (group === undefined) return { kind: "report", name, parameters: {} };
  return { kind: "report", name, parameters: parseParameters(group.slice(1, -1), original) };
}

function parseParameters(source: string, original: string): Readonly<Record<string, string | number | boolean>> {
  const parameters: Record<string, string | number | boolean> = {};
  const text = source.trim();
  if (text === "") return parameters;
  for (const part of splitParameters(text, original)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*(?:=>|=)\s*([\s\S]+)$/.exec(part.trim());
    if (match === null) throw new QueryError("Write each report parameter as name => 'value'.", PROVIDER, original);
    const key = match[1] ?? "";
    parameters[key] = parseValue(match[2] ?? "", original);
  }
  return parameters;
}

function splitParameters(source: string, original: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] ?? "";
    if (quote) {
      current += character;
      if (character === "'" && source[index + 1] === "'") {
        current += "'";
        index += 1;
      } else if (character === "'") quote = false;
      continue;
    }
    if (character === "'") {
      quote = true;
      current += character;
      continue;
    }
    if (character === ",") {
      parts.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  if (quote) throw new QueryError(UNREADABLE, PROVIDER, original);
  parts.push(current);
  return parts;
}

function parseValue(token: string, original: string): string | number | boolean {
  const value = token.trim();
  if (/^true$/i.test(value)) return true;
  if (/^false$/i.test(value)) return false;
  if (/^-?\d+$/.test(value)) return Number(value);
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    return value.slice(1, -1).replaceAll("''", "'");
  }
  throw new QueryError(
    "Write a report parameter as text in quotes, a whole number, or true or false.",
    PROVIDER,
    original,
  );
}

function leadingWord(sql: string): string {
  const word = readCode(sql).match(/[A-Za-z_][A-Za-z0-9_]*/);
  return word === null ? "" : word[0].toUpperCase();
}

function hasAnotherStatement(sql: string): boolean {
  const code = readCode(sql);
  const semicolon = code.indexOf(";");
  if (semicolon === -1) return false;
  return code.slice(semicolon + 1).trim() !== "";
}

/** Statement text with comments and quoted runs blanked, so a semicolon inside them is not a second statement. */
function readCode(sql: string): string {
  let out = "";
  let mode: "code" | "line" | "block" | "single" | "double" = "code";
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index] ?? "";
    const next = sql[index + 1] ?? "";
    if (mode === "line") {
      out += character === "\n" ? "\n" : " ";
      if (character === "\n") mode = "code";
      continue;
    }
    if (mode === "block") {
      out += character === "\n" ? "\n" : " ";
      if (character === "*" && next === "/") {
        out += " ";
        index += 1;
        mode = "code";
      }
      continue;
    }
    if (mode === "single" || mode === "double") {
      const quote = mode === "single" ? "'" : '"';
      out += " ";
      if (character === quote && next === quote) {
        out += " ";
        index += 1;
      } else if (character === quote) mode = "code";
      continue;
    }
    if (character === "-" && next === "-") {
      out += "  ";
      index += 1;
      mode = "line";
      continue;
    }
    if (character === "/" && next === "*") {
      out += "  ";
      index += 1;
      mode = "block";
      continue;
    }
    if (character === "'") {
      out += " ";
      mode = "single";
      continue;
    }
    if (character === '"') {
      out += " ";
      mode = "double";
      continue;
    }
    out += character;
  }
  if (mode === "single" || mode === "double" || mode === "block") {
    throw new QueryError(UNREADABLE, PROVIDER, sql);
  }
  return out;
}
