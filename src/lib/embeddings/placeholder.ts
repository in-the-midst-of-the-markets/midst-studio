/**
 * Text a statement asks to turn into a vector, and the older `{{embed ...}}` forms.
 *
 * `{{the text}}` is embedded only when it is the vector value: the JSON value of
 * `vector`, `data` or `nearest`, a Qdrant `query` that is that text or a list, or
 * the second argument of `knn`. The same brackets elsewhere stay a chart filter.
 * `{{embed "text"}}` is what the server embeds. `{{embed name}}` is filled from a
 * dashboard filter first. A space after `embed` keeps that form out of the filter parser.
 */

const EMBED_MARK = "{{embed";
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,39}/;

export interface EmbedToken {
  readonly start: number;
  readonly end: number;
  readonly kind: "text" | "name";
  readonly value: string;
}

function skipSpace(sql: string, index: number): number {
  let cursor = index;
  while (cursor < sql.length && /\s/.test(sql[cursor] ?? "")) cursor += 1;
  return cursor;
}

function readJsonString(sql: string, start: number): { value: string; end: number } | null {
  let cursor = start + 1;
  let raw = '"';
  while (cursor < sql.length) {
    const char = sql[cursor] ?? "";
    raw += char;
    if (char === "\\") {
      cursor += 1;
      if (cursor >= sql.length) return null;
      raw += sql[cursor] ?? "";
    } else if (char === '"') {
      try {
        const value: unknown = JSON.parse(raw);
        if (typeof value !== "string") return null;
        return { value, end: cursor + 1 };
      } catch {
        return null;
      }
    }
    cursor += 1;
  }
  return null;
}

function readName(sql: string, start: number): { value: string; end: number } | null {
  const match = NAME_PATTERN.exec(sql.slice(start));
  if (match === null) return null;
  return { value: match[0], end: start + match[0].length };
}

function parseEmbedAt(sql: string, at: number): EmbedToken | null {
  let cursor = at + EMBED_MARK.length;
  const gap = sql[cursor];
  if (gap !== " " && gap !== "\t" && gap !== "\n" && gap !== "\r") return null;
  cursor = skipSpace(sql, cursor);
  if (sql[cursor] === '"') {
    const text = readJsonString(sql, cursor);
    if (text === null) return null;
    cursor = skipSpace(sql, text.end);
    if (!sql.startsWith("}}", cursor)) return null;
    return { start: at, end: cursor + 2, kind: "text", value: text.value };
  }
  const name = readName(sql, cursor);
  if (name === null) return null;
  cursor = skipSpace(sql, name.end);
  if (!sql.startsWith("}}", cursor)) return null;
  return { start: at, end: cursor + 2, kind: "name", value: name.value };
}

/** Every `{{embed ...}}` token. A broken one is left in the text and skipped. */
function namedEmbedTokens(sql: string): EmbedToken[] {
  const tokens: EmbedToken[] = [];
  let index = 0;
  while (index < sql.length) {
    const at = sql.indexOf(EMBED_MARK, index);
    if (at < 0) break;
    const parsed = parseEmbedAt(sql, at);
    if (parsed === null) {
      index = at + EMBED_MARK.length;
      continue;
    }
    tokens.push(parsed);
    index = parsed.end;
  }
  return tokens;
}

/** The text inside `{{...}}`. A JSON string is unquoted; anything else is kept as typed. */
function plainValue(body: string): string {
  const trimmed = body.trim();
  if (!trimmed.startsWith('"')) return trimmed;
  const parsed = readJsonString(trimmed, 0);
  if (parsed !== null && parsed.end === trimmed.length) return parsed.value;
  return trimmed;
}

function readPlainToken(sql: string, at: number): EmbedToken | null {
  if (!sql.startsWith("{{", at)) return null;
  let cursor = at + 2;
  while (cursor < sql.length) {
    if (sql.startsWith("}}", cursor)) {
      return { start: at, end: cursor + 2, kind: "text", value: plainValue(sql.slice(at + 2, cursor)) };
    }
    const char = sql[cursor] ?? "";
    // A bracket here belongs to the JSON around the value, so this is not one token.
    if (char === "{" || char === "}" || char === "]") return null;
    cursor += 1;
  }
  return null;
}

/** The end of a JSON array or object, ignoring brackets that sit inside a string. */
function readBracket(sql: string, start: number, open: "[" | "{", close: "]" | "}"): number | null {
  let depth = 0;
  let quote = false;
  let escaped = false;
  for (let cursor = start; cursor < sql.length; cursor += 1) {
    const char = sql[cursor] ?? "";
    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === '"') quote = false;
      continue;
    }
    if (char === '"') {
      quote = true;
      continue;
    }
    if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return cursor + 1;
    }
  }
  return null;
}

/** Where one JSON value ends, when it is a token, a string, a list, an object, or a literal. */
function jsonValueEnd(sql: string, start: number): number | null {
  if (sql.startsWith("{{", start)) {
    const token = readPlainToken(sql, start);
    return token === null ? null : token.end;
  }
  const char = sql[start] ?? "";
  if (char === '"') {
    const text = readJsonString(sql, start);
    return text === null ? null : text.end;
  }
  if (char === "[") return readBracket(sql, start, "[", "]");
  if (char === "{") return readBracket(sql, start, "{", "}");
  if (char === "-" || (char >= "0" && char <= "9")) {
    let cursor = start + 1;
    while (cursor < sql.length && /[0-9.eE+-]/.test(sql[cursor] ?? "")) cursor += 1;
    return cursor;
  }
  if (sql.startsWith("true", start)) return start + 4;
  if (sql.startsWith("false", start)) return start + 5;
  if (sql.startsWith("null", start)) return start + 4;
  return null;
}

function pushToken(sql: string, at: number, claimed: ReadonlySet<number>, out: EmbedToken[]): number | null {
  const token = readPlainToken(sql, at);
  if (token === null) return null;
  if (!claimed.has(token.start)) out.push(token);
  return token.end;
}

function pushQuotedToken(sql: string, at: number, claimed: ReadonlySet<number>, out: EmbedToken[]): number | null {
  const text = readJsonString(sql, at);
  if (text === null) return null;
  if (text.value.startsWith("{{") && text.value.endsWith("}}")) {
    const token = readPlainToken(sql, at + 1);
    if (token !== null && token.end === text.end - 1) pushToken(sql, at + 1, claimed, out);
  }
  return text.end;
}

/**
 * Tokens that are the whole value, or a whole element of its list.
 * A nested list is one element, so `{{text}}` replaces the vector rather than one of its numbers.
 */
function collectInValue(
  sql: string,
  start: number,
  end: number,
  claimed: ReadonlySet<number>,
  out: EmbedToken[],
): void {
  const at = skipSpace(sql, start);
  if (at >= end) return;
  if (sql.startsWith("{{", at)) {
    pushToken(sql, at, claimed, out);
    return;
  }
  if (sql[at] === '"') {
    pushQuotedToken(sql, at, claimed, out);
    return;
  }
  if (sql[at] !== "[") return;
  let cursor = at + 1;
  while (cursor < end) {
    cursor = skipSpace(sql, cursor);
    if (cursor >= end || sql[cursor] === "]") break;
    if (sql.startsWith("{{", cursor)) {
      const next = pushToken(sql, cursor, claimed, out);
      if (next === null) break;
      cursor = next;
    } else if (sql[cursor] === '"') {
      const next = pushQuotedToken(sql, cursor, claimed, out);
      if (next === null) break;
      cursor = next;
    } else {
      const next = jsonValueEnd(sql, cursor);
      if (next === null || next <= cursor) break;
      cursor = next;
    }
    cursor = skipSpace(sql, cursor);
    if (sql[cursor] === ",") cursor += 1;
  }
}

/** The first knn argument ends at a comma that is not inside quotes or parentheses. */
function skipArgument(sql: string, start: number): number | null {
  let depth = 0;
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (let cursor = start; cursor < sql.length; cursor += 1) {
    const char = sql[cursor] ?? "";
    if (quote !== null) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char === ")") {
      if (depth === 0) return null;
      depth -= 1;
      continue;
    }
    if (char === "," && depth === 0) return cursor;
  }
  return null;
}

function collectKnn(sql: string, claimed: ReadonlySet<number>, out: EmbedToken[]): void {
  for (const match of sql.matchAll(/\bknn(?:_score)?\s*\(/gi)) {
    const open = (match.index ?? 0) + match[0].length;
    const comma = skipArgument(sql, open);
    if (comma === null) continue;
    const cursor = skipSpace(sql, comma + 1);
    if (sql[cursor] === "'" || sql[cursor] === '"') {
      const quote = sql[cursor];
      const token = readPlainToken(sql, cursor + 1);
      if (token !== null && sql[token.end] === quote) pushToken(sql, cursor + 1, claimed, out);
      continue;
    }
    if (sql.startsWith("{{", cursor)) pushToken(sql, cursor, claimed, out);
  }
}

/**
 * `{{text}}` standing where the vector goes.
 * A Qdrant `query` object is a search, not a vector, so a filter inside it is left alone.
 */
function vectorFieldTokens(sql: string, claimed: ReadonlySet<number>): EmbedToken[] {
  const out: EmbedToken[] = [];
  for (const match of sql.matchAll(/"(vector|data|nearest|query)"\s*:/g)) {
    const key = match[1] ?? "";
    const valueAt = skipSpace(sql, (match.index ?? 0) + match[0].length);
    if (key === "query" && sql[valueAt] === "{") continue;
    const valueEnd = jsonValueEnd(sql, valueAt);
    if (valueEnd === null) continue;
    collectInValue(sql, valueAt, valueEnd, claimed, out);
  }
  collectKnn(sql, claimed, out);
  return out;
}

/** Every embed token in source order. A broken token is left in the text and skipped. */
export function embedTokens(sql: string): EmbedToken[] {
  const named = namedEmbedTokens(sql);
  const claimed = new Set(named.map((token) => token.start));
  return [...named, ...vectorFieldTokens(sql, claimed)].sort((left, right) => left.start - right.start);
}

export interface EmbedNameValue {
  readonly name: string;
  readonly value: string;
}

const TEXT_CAP = 4000;
const FILTER_ID = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;

/**
 * A vector value that is exactly a filter id takes that filter's text.
 * Any other words there are embedded as written. An id with no text stays a
 * name, so the id itself is not embedded.
 */
export function bindVectorFilterIds(sql: string, values: readonly EmbedNameValue[]): string {
  const ids = new Set<string>();
  const byName = new Map<string, string>();
  for (const item of values) {
    const name = item.name.trim();
    if (!FILTER_ID.test(name)) continue;
    ids.add(name);
    const value = item.value.trim();
    if (value !== "") byName.set(name, value.slice(0, TEXT_CAP));
  }
  let next = sql;
  for (const token of [...embedTokens(sql)].reverse()) {
    if (token.kind !== "text" || !ids.has(token.value)) continue;
    const text = byName.get(token.value);
    const body = text === undefined ? `{{embed ${token.value}}}` : `{{embed ${JSON.stringify(text)}}}`;
    next = `${next.slice(0, token.start)}${body}${next.slice(token.end)}`;
  }
  return next;
}

/**
 * Replaces `{{embed name}}` with `{{embed "value"}}` when that filter has text.
 * An empty filter stays a name, so the server can say which one is missing.
 */
export function bindEmbedPlaceholders(sql: string, values: readonly EmbedNameValue[]): string {
  const byName = new Map<string, string>();
  for (const item of values) {
    const name = item.name.trim();
    const value = item.value.trim();
    if (!NAME_PATTERN.test(name) || name.length > 40 || value === "") continue;
    byName.set(name, value.slice(0, TEXT_CAP));
  }
  let next = sql;
  for (const token of [...embedTokens(sql)].reverse()) {
    if (token.kind !== "name") continue;
    const text = byName.get(token.value);
    if (text === undefined) continue;
    next = `${next.slice(0, token.start)}{{embed ${JSON.stringify(text)}}}${next.slice(token.end)}`;
  }
  return next;
}

/** The number list a database reads. Only finite numbers reach this, so the text cannot close a quote. */
function embeddingVectorLiteral(values: readonly number[]): string {
  return `[${values.join(",")}]`;
}

/**
 * Where a token is replaced.
 *
 * A JSON string that holds nothing but the token is part of the replacement, so
 * `"{{embed e1}}"` becomes a list. A SQL string uses single quotes and keeps them.
 */
function embeddingSpan(sql: string, token: EmbedToken): { start: number; end: number } {
  if (sql[token.start - 1] === '"' && sql[token.end] === '"') {
    return { start: token.start - 1, end: token.end + 1 };
  }
  return { start: token.start, end: token.end };
}

const embedMask = (index: number): string => `"__MIDST_EMBED_${index}__"`;

/**
 * Stands a JSON string in for each embed token so a JSON formatter can read the body.
 * `spans` is the original text, quotes included when the token was the whole string.
 */
export function maskEmbeddingTokens(sql: string): { text: string; spans: readonly string[] } {
  const tokens = embedTokens(sql);
  const spans: string[] = [];
  let text = sql;
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = tokens[index];
    if (token === undefined) continue;
    const span = embeddingSpan(text, token);
    spans[index] = text.slice(span.start, span.end);
    text = `${text.slice(0, span.start)}${embedMask(index)}${text.slice(span.end)}`;
  }
  return { text, spans };
}

/** Puts the masked tokens back. A mask format moved is still the same characters. */
export function restoreEmbeddingTokens(sql: string, spans: readonly string[]): string {
  let text = sql;
  for (let index = 0; index < spans.length; index += 1) {
    const span = spans[index];
    if (span === undefined) continue;
    text = text.replace(embedMask(index), span);
  }
  return text;
}

/**
 * The same text with each embed token standing in for one number.
 *
 * A console grammar reads this before the server has embedded anything, so an id in
 * the vector field is a list rather than a broken object or a string.
 */
export function embedProbeText(sql: string): string {
  const tokens = embedTokens(sql);
  let next = sql;
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = tokens[index];
    if (token === undefined) continue;
    const span = embeddingSpan(next, token);
    next = `${next.slice(0, span.start)}[0]${next.slice(span.end)}`;
  }
  return next;
}

/** Splices one vector in place of each quoted embed token, from the end so earlier indexes stay put. */
export function spliceEmbeddingVectors(sql: string, vectors: readonly (readonly number[])[]): string {
  const tokens = embedTokens(sql).filter((token) => token.kind === "text");
  let next = sql;
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = tokens[index];
    const vector = vectors[index];
    if (token === undefined || vector === undefined) continue;
    const span = embeddingSpan(next, token);
    next = `${next.slice(0, span.start)}${embeddingVectorLiteral(vector)}${next.slice(span.end)}`;
  }
  return next;
}
