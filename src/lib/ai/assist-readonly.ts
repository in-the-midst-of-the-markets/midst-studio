/**
 * The read-only gate for statements the AI Assist page will run.
 *
 * The model writes the SQL, and the page runs it on the active connection. A statement
 * is allowed when it is one statement and it only reads: SELECT, TABLE, VALUES, SHOW,
 * DESCRIBE, EXPLAIN of a read, PRAGMA, or a WITH whose parts are the same. A write, a
 * second statement, a row lock, and SELECT INTO are refused before anything is sent.
 */

import { readLeadingKeyword } from "@/lib/sql/leading-keyword";

const READ = new Set(["SELECT", "TABLE", "VALUES", "SHOW", "DESCRIBE", "DESC", "EXPLAIN", "PRAGMA"]);

/** How deep EXPLAIN and WITH may nest before the statement is refused. */
const MAX_DEPTH = 6;

function skipLine(sql: string, index: number): number {
  const newline = sql.indexOf("\n", index);
  return newline === -1 ? sql.length : newline + 1;
}

function skipBlock(sql: string, index: number): number {
  const end = sql.indexOf("*/", index + 2);
  return end === -1 ? -1 : end + 2;
}

/** The index after whitespace and comments, or -1 when a block comment never closes. */
function skipTrivia(sql: string, index: number): number {
  let i = index;
  while (i < sql.length) {
    const current = sql[i];
    const next = sql[i + 1];
    if (current === "-" && next === "-") {
      i = skipLine(sql, i);
      continue;
    }
    if (current === "/" && next === "*") {
      const end = skipBlock(sql, i);
      if (end < 0) return -1;
      i = end;
      continue;
    }
    if (current !== undefined && /\s/.test(current)) {
      i += 1;
      continue;
    }
    break;
  }
  return i;
}

/**
 * One statement: code, then an optional semicolon, then only whitespace and comments.
 * A semicolon inside a quote or a comment does not split the statement.
 */
function singleStatement(sql: string): boolean {
  let quote: "'" | '"' | "`" | null = null;
  let sawCode = false;
  let sawSemicolon = false;
  for (let i = 0; i < sql.length; i += 1) {
    const current = sql[i];
    if (quote !== null) {
      if (current === quote) {
        if (sql[i + 1] === quote) {
          i += 1;
          continue;
        }
        quote = null;
      }
      continue;
    }
    if (current === "-" && sql[i + 1] === "-") {
      i = skipLine(sql, i) - 1;
      continue;
    }
    if (current === "/" && sql[i + 1] === "*") {
      const end = skipBlock(sql, i);
      if (end < 0) return false;
      i = end - 1;
      continue;
    }
    if (current === "'" || current === '"' || current === "`") {
      quote = current;
      sawCode = true;
      continue;
    }
    if (current === ";") {
      if (sawSemicolon) return false;
      sawSemicolon = true;
      continue;
    }
    if (current !== undefined && !/\s/.test(current)) {
      if (sawSemicolon) return false;
      sawCode = true;
    }
  }
  return sawCode && quote === null;
}

/** Comments and quoted text replaced with spaces, so a word scan cannot see inside them. */
function stripLiterals(sql: string): string {
  let out = "";
  let quote: "'" | '"' | "`" | null = null;
  for (let i = 0; i < sql.length; i += 1) {
    const current = sql[i];
    if (quote !== null) {
      out += " ";
      if (current === quote && sql[i + 1] !== quote) quote = null;
      else if (current === quote) i += 1;
      continue;
    }
    if (current === "-" && sql[i + 1] === "-") {
      const end = skipLine(sql, i);
      out += " ".repeat(end - i);
      i = end - 1;
      continue;
    }
    if (current === "/" && sql[i + 1] === "*") {
      const end = skipBlock(sql, i);
      const stop = end < 0 ? sql.length : end;
      out += " ".repeat(stop - i);
      i = stop - 1;
      continue;
    }
    if (current === "'" || current === '"' || current === "`") {
      quote = current;
      out += " ";
      continue;
    }
    out += current;
  }
  return out;
}

function locksOrSelectsInto(sql: string): boolean {
  const plain = stripLiterals(sql);
  return /\bfor\s+update\b/i.test(plain) || /\binto\b/i.test(plain);
}

function skipIdent(sql: string, index: number): number {
  const start = skipTrivia(sql, index);
  if (start < 0) return -1;
  const current = sql[start];
  if (current === undefined) return -1;
  if (current === '"' || current === "`" || current === "[") {
    const close = current === "[" ? "]" : current;
    const end = sql.indexOf(close, start + 1);
    return end < 0 ? -1 : end + 1;
  }
  if (!/[A-Za-z_]/.test(current)) return -1;
  let end = start + 1;
  while (end < sql.length && /[A-Za-z0-9_]/.test(sql[end] ?? "")) end += 1;
  return end;
}

function skipBalanced(sql: string, index: number): number {
  let depth = 0;
  let quote: "'" | '"' | "`" | null = null;
  for (let i = index; i < sql.length; i += 1) {
    const current = sql[i];
    if (quote !== null) {
      if (current === quote) {
        if (sql[i + 1] === quote) {
          i += 1;
          continue;
        }
        quote = null;
      }
      continue;
    }
    if (current === "-" && sql[i + 1] === "-") {
      i = skipLine(sql, i) - 1;
      continue;
    }
    if (current === "/" && sql[i + 1] === "*") {
      const end = skipBlock(sql, i);
      if (end < 0) return -1;
      i = end - 1;
      continue;
    }
    if (current === "'" || current === '"' || current === "`") {
      quote = current;
      continue;
    }
    if (current === "(") depth += 1;
    else if (current === ")") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

function readOnlyAt(sql: string, depth: number): boolean {
  if (depth > MAX_DEPTH) return false;
  if (!singleStatement(sql)) return false;
  const leading = readLeadingKeyword(sql);
  if (leading === null) return false;
  if (leading.keyword === "WITH") return withIsReadOnly(sql, leading.end, depth);
  if (leading.keyword === "EXPLAIN") return readOnlyAt(sql.slice(leading.end), depth + 1);
  if (!READ.has(leading.keyword)) return false;
  return !locksOrSelectsInto(sql);
}

function withIsReadOnly(sql: string, from: number, depth: number): boolean {
  let i = skipTrivia(sql, from);
  if (i < 0) return false;
  if (/^recursive\b/i.test(sql.slice(i))) i = skipTrivia(sql, i + "recursive".length);
  if (i < 0) return false;
  for (let guard = 0; guard < 32; guard += 1) {
    i = skipIdent(sql, i);
    if (i < 0) return false;
    i = skipTrivia(sql, i);
    if (i < 0) return false;
    if (sql[i] === "(") {
      const end = skipBalanced(sql, i);
      if (end < 0) return false;
      i = skipTrivia(sql, end);
      if (i < 0) return false;
    }
    if (!/^as\b/i.test(sql.slice(i))) return false;
    i = skipTrivia(sql, i + 2);
    if (i < 0 || sql[i] !== "(") return false;
    const end = skipBalanced(sql, i);
    if (end < 0) return false;
    if (!readOnlyAt(sql.slice(i + 1, end - 1), depth + 1)) return false;
    i = skipTrivia(sql, end);
    if (i < 0) return false;
    if (sql[i] === ",") {
      i = skipTrivia(sql, i + 1);
      if (i < 0) return false;
      continue;
    }
    return readOnlyAt(sql.slice(i), depth + 1);
  }
  return false;
}

/** Whether AI Assist may run this text on the active connection. */
export function isReadOnlySql(sql: string): boolean {
  return readOnlyAt(sql, 0);
}
