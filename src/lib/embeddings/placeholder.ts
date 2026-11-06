/**
 * `{{embed "text"}}` and `{{embed name}}` in a statement.
 *
 * A space after `embed` keeps the token out of the dashboard filter parser, which
 * reads `{{name}}` with no space. The name form is filled from a dashboard filter
 * before the request leaves the browser. The quoted form is what the server embeds.
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

/** Every embed token in source order. A broken token is left in the text and skipped. */
export function embedTokens(sql: string): EmbedToken[] {
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

export interface EmbedNameValue {
  readonly name: string;
  readonly value: string;
}

const TEXT_CAP = 4000;

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

/** Splices one vector in place of each quoted embed token, from the end so earlier indexes stay put. */
export function spliceEmbeddingVectors(sql: string, vectors: readonly (readonly number[])[]): string {
  const tokens = embedTokens(sql).filter((token) => token.kind === "text");
  let next = sql;
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = tokens[index];
    const vector = vectors[index];
    if (token === undefined || vector === undefined) continue;
    next = `${next.slice(0, token.start)}${embeddingVectorLiteral(vector)}${next.slice(token.end)}`;
  }
  return next;
}
