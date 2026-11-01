/**
 * Notes a person writes about a connection's tables, for themselves and for AI.
 *
 * Hex's data browser is the model: a description of what a table is for, what a column's
 * values look like, and whether the assistant should prefer or avoid that table. The same
 * record accepts an uploaded schema design — SQL `CREATE TABLE`, DBML, or JSON — because a
 * design names tables and relationships the live catalog may not have loaded yet.
 *
 * `applyDictionary` folds a saved record into the schema JSON the AI panels already send.
 * With nothing saved it returns that JSON unchanged.
 */

import { pathKey } from "@/lib/db/object-path";

/** How the assistant should treat one table. `normal` is the default and is not written out. */
export type TableEndorsement = "endorsed" | "normal" | "excluded";

export interface RelationshipNote {
  readonly fromColumn: string;
  readonly toTable: string;
  readonly toColumn: string;
}

export interface TableNote {
  readonly path: readonly string[];
  readonly description: string;
  readonly endorsement: TableEndorsement;
  /** Column name to the note the user wrote. */
  readonly columns: Readonly<Record<string, string>>;
  /** Types learned from an uploaded design, for columns the live catalog has not described. */
  readonly columnTypes: Readonly<Record<string, string>>;
  readonly relationships: readonly RelationshipNote[];
}

export interface DataDictionary {
  readonly connectionId: string;
  /** Notes about the whole database: jargon, and which tables to prefer. */
  readonly notes: string;
  readonly tables: readonly TableNote[];
  readonly updatedAt: string;
}

export interface SchemaDesign {
  readonly notes: string;
  readonly tables: readonly TableNote[];
}

export type SchemaDesignResult = { ok: true; design: SchemaDesign } | { ok: false; error: string };

/** One live object, as much of it as matching a note needs. */
export interface NamedColumns {
  readonly name: string;
  readonly path: readonly string[];
  readonly columns: readonly { readonly name: string }[];
}

/**
 * Told to the model wherever the schema JSON is, so a `description` is read as the user's
 * note and an uploaded design is not mistaken for a table the database already has.
 */
export const DICTIONARY_HINT =
  'Fields named description, dictionaryNotes, and endorsement are notes the user wrote. Prefer an object whose endorsement is "endorsed". Do not use an object whose endorsement is "excluded" unless the question names it. An object with designed set to true comes from an uploaded schema design and may not exist in the database yet.';

const FILE_CAP = 1_000_000;
const TEXT_CAP = 2_000;
const NOTES_CAP = 4_000;
const TABLE_CAP = 300;

const UNRECOGNIZED = "Upload a schema design as SQL (CREATE TABLE), DBML, or JSON.";
const NOT_JSON_DESIGN = "This JSON is not a schema design. Use a tables list or a schema snapshot.";
const EMPTY_DESIGN = "That file has no tables or notes to import.";
const TOO_BIG = "That file is too large to import.";

export function emptyDictionary(connectionId: string): DataDictionary {
  return { connectionId, notes: "", tables: [], updatedAt: "" };
}

function clip(text: string, cap: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= cap) return trimmed;
  return `${trimmed.slice(0, cap - 1)}…`;
}

function lastSegment(path: readonly string[]): string {
  return path.length === 0 ? "" : path[path.length - 1];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function endorsementOf(value: unknown): TableEndorsement {
  return value === "endorsed" || value === "excluded" ? value : "normal";
}

export function parseSchemaDesign(text: string): SchemaDesignResult {
  if (text.length > FILE_CAP) return { ok: false, error: TOO_BIG };
  const trimmed = text.trim();
  if (trimmed === "") return { ok: false, error: EMPTY_DESIGN };
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const json = parseJsonDesign(trimmed);
    if (json === null) return { ok: false, error: NOT_JSON_DESIGN };
    if (json === "syntax") return { ok: false, error: UNRECOGNIZED };
    if (json.notes === "" && json.tables.length === 0) return { ok: false, error: EMPTY_DESIGN };
    return { ok: true, design: capDesign(json) };
  }
  const dbml = parseDbml(trimmed);
  if (dbml !== null) return { ok: true, design: capDesign(dbml) };
  const sql = parseSql(trimmed);
  if (sql !== null) return { ok: true, design: capDesign(sql) };
  return { ok: false, error: UNRECOGNIZED };
}

function capDesign(design: SchemaDesign): SchemaDesign {
  const tables = design.tables.slice(0, TABLE_CAP);
  const dropped = design.tables.length - tables.length;
  const notes = dropped > 0 ? clip(`${design.notes}\nShowing the first ${TABLE_CAP} tables.`, NOTES_CAP) : design.notes;
  return { notes: clip(notes, NOTES_CAP), tables };
}

export function mergeDesign(
  current: DataDictionary | null,
  connectionId: string,
  design: SchemaDesign,
): DataDictionary {
  const base = current !== null && current.connectionId === connectionId ? current : emptyDictionary(connectionId);
  const tables = [...base.tables];
  for (const incoming of design.tables) {
    const index = tables.findIndex((table) => pathKey(table.path) === pathKey(incoming.path));
    if (index === -1) {
      tables.push(incoming);
      continue;
    }
    tables[index] = mergeTable(tables[index], incoming);
  }
  return {
    connectionId,
    notes: design.notes.trim() === "" ? base.notes : clip(design.notes, NOTES_CAP),
    tables: tables.slice(0, TABLE_CAP),
    updatedAt: new Date().toISOString(),
  };
}

function mergeTable(current: TableNote, incoming: TableNote): TableNote {
  const columns: Record<string, string> = { ...current.columns };
  for (const [name, description] of Object.entries(incoming.columns)) {
    if (description.trim() !== "") columns[name] = description;
  }
  return {
    path: current.path,
    description: incoming.description.trim() === "" ? current.description : incoming.description,
    endorsement: incoming.endorsement === "normal" ? current.endorsement : incoming.endorsement,
    columns,
    columnTypes: { ...current.columnTypes, ...incoming.columnTypes },
    relationships: incoming.relationships.length > 0 ? incoming.relationships : current.relationships,
  };
}

/** The note written for this object: its address, or a bare name when that name is unique. */
export function noteForObject(
  notes: readonly TableNote[],
  object: NamedColumns,
  objects: readonly NamedColumns[],
): TableNote | null {
  const exact = notes.find((note) => pathKey(note.path) === pathKey(object.path));
  if (exact !== undefined) return exact;
  return notes.find((note) => note.path.length === 1 && liveTable(objects, note.path) === object) ?? null;
}

export function liveTable(objects: readonly NamedColumns[], path: readonly string[]): NamedColumns | null {
  const exact = objects.find((object) => pathKey(object.path) === pathKey(path));
  if (exact !== undefined) return exact;
  if (path.length !== 1) return null;
  const named = objects.filter((object) => object.name === path[0] || lastSegment(object.path) === path[0]);
  return named.length === 1 ? named[0] : null;
}

/** Column names to offer for one note: the live table's columns, then any the design added. */
export function noteColumnNames(note: TableNote, objects: readonly NamedColumns[]): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const add = (name: string): void => {
    if (name === "" || seen.has(name)) return;
    seen.add(name);
    names.push(name);
  };
  for (const column of liveTable(objects, note.path)?.columns ?? []) add(column.name);
  for (const name of Object.keys(note.columns)) add(name);
  for (const name of Object.keys(note.columnTypes)) add(name);
  return names;
}

function isBlank(dictionary: DataDictionary): boolean {
  if (dictionary.notes.trim() !== "") return false;
  return dictionary.tables.every(
    (table) =>
      table.description.trim() === "" &&
      table.endorsement === "normal" &&
      Object.keys(table.columns).length === 0 &&
      Object.keys(table.columnTypes).length === 0 &&
      table.relationships.length === 0,
  );
}

/**
 * The schema JSON the AI panels send, with this connection's notes folded in.
 *
 * A missing or empty dictionary returns `schemaContext` unchanged, so a connection nobody
 * has annotated keeps the bytes it had. A table the design names and the live schema does
 * not is appended with `designed: true`.
 */
export function applyDictionary(schemaContext: string, dictionary: DataDictionary | null): string {
  if (dictionary === null || isBlank(dictionary)) return schemaContext;
  let parsed: unknown;
  try {
    parsed = JSON.parse(schemaContext);
  } catch {
    return schemaContext;
  }
  if (!Array.isArray(parsed)) return schemaContext;

  const entries = parsed.filter(isRecord);
  const passthrough = parsed.length !== entries.length;
  if (passthrough) return schemaContext;

  const bound = bindNotes(entries, dictionary.tables);
  const next: Record<string, unknown>[] = [];
  for (const entry of entries) {
    const note = bound.map.get(entry);
    next.push(note === undefined ? entry : enrich(entry, note));
  }
  for (const note of dictionary.tables) {
    if (bound.used.has(note)) continue;
    if (isBlank({ ...dictionary, notes: "", tables: [note] })) continue;
    next.push(designedObject(note));
  }
  if (dictionary.notes.trim() !== "") {
    if (next.length > 0) next[0] = { ...next[0], dictionaryNotes: dictionary.notes };
    else next.push({ designed: true, name: "(notes)", dictionaryNotes: dictionary.notes, columns: [] });
  }
  return JSON.stringify(next);
}

function livePath(entry: Record<string, unknown>): string[] {
  const path = stringList(entry.path);
  if (path !== null) return path;
  return typeof entry.name === "string" && entry.name.length > 0 ? [entry.name] : [];
}

/**
 * Which note describes which live object.
 *
 * An exact address wins. A bare name matches only when one remaining note and one
 * remaining object share it, so two `orders` tables in two schemas do not both inherit
 * a note that never said which one. A qualified note never attaches to a different
 * qualified path.
 */
function bindNotes(
  entries: readonly Record<string, unknown>[],
  notes: readonly TableNote[],
): { map: Map<Record<string, unknown>, TableNote>; used: Set<TableNote> } {
  const used = new Set<TableNote>();
  const map = new Map<Record<string, unknown>, TableNote>();
  for (const entry of entries) {
    const path = livePath(entry);
    const exact = notes.find((note) => !used.has(note) && path.length > 0 && pathKey(note.path) === pathKey(path));
    if (exact === undefined) continue;
    used.add(exact);
    map.set(entry, exact);
  }
  for (const note of notes) {
    if (used.has(note) || note.path.length !== 1) continue;
    const hits = entries.filter((entry) => !map.has(entry) && lastSegment(livePath(entry)) === note.path[0]);
    if (hits.length !== 1) continue;
    used.add(note);
    map.set(hits[0], note);
  }
  return { map, used };
}

function enrich(entry: Record<string, unknown>, note: TableNote): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...entry };
  if (note.description.trim() !== "") copy.description = note.description;
  if (note.endorsement !== "normal") copy.endorsement = note.endorsement;
  if (note.relationships.length > 0) copy.relationships = note.relationships.map((rel) => ({ ...rel }));
  const columns = enrichColumns(entry.columns, note);
  if (columns !== null) copy.columns = columns;
  return copy;
}

function enrichColumns(value: unknown, note: TableNote): Record<string, unknown>[] | null {
  const columns = Array.isArray(value) ? value.filter(isRecord) : [];
  if (!Array.isArray(value) && Object.keys(note.columns).length === 0 && Object.keys(note.columnTypes).length === 0) {
    return null;
  }
  const seen = new Set<string>();
  const next: Record<string, unknown>[] = [];
  for (const column of columns) {
    const name = typeof column.name === "string" ? column.name : "";
    if (name !== "") seen.add(name);
    const description = note.columns[name];
    next.push(description ? { ...column, description } : column);
  }
  for (const [name, description] of Object.entries(note.columns)) {
    if (seen.has(name)) continue;
    seen.add(name);
    next.push({ name, type: note.columnTypes[name] ?? "unknown", description, designed: true });
  }
  for (const [name, type] of Object.entries(note.columnTypes)) {
    if (seen.has(name)) continue;
    next.push({ name, type, designed: true });
  }
  return next;
}

function designedObject(note: TableNote): Record<string, unknown> {
  const object: Record<string, unknown> = {
    name: lastSegment(note.path),
    path: [...note.path],
    designed: true,
    columns: enrichColumns([], note) ?? [],
  };
  if (note.description.trim() !== "") object.description = note.description;
  if (note.endorsement !== "normal") object.endorsement = note.endorsement;
  if (note.relationships.length > 0) object.relationships = note.relationships.map((rel) => ({ ...rel }));
  return object;
}

function blankTable(path: readonly string[]): TableNote {
  return { path, description: "", endorsement: "normal", columns: {}, columnTypes: {}, relationships: [] };
}

function rememberRelationship(table: TableNote, rel: RelationshipNote): TableNote {
  const exists = table.relationships.some(
    (item) => item.fromColumn === rel.fromColumn && item.toTable === rel.toTable && item.toColumn === rel.toColumn,
  );
  if (exists) return table;
  return { ...table, relationships: [...table.relationships, rel] };
}

function skipSpace(source: string, index: number): number {
  let i = index;
  while (i < source.length) {
    const ch = source[i];
    if (ch === " " || ch === "\n" || ch === "\r" || ch === "\t") {
      i += 1;
      continue;
    }
    if (source.startsWith("--", i)) {
      const nl = source.indexOf("\n", i);
      i = nl === -1 ? source.length : nl + 1;
      continue;
    }
    if (source.startsWith("/*", i)) {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    break;
  }
  return i;
}

function readIdent(source: string, index: number): { value: string; end: number } | null {
  const i = skipSpace(source, index);
  const ch = source[i];
  if (ch === '"' || ch === "`") {
    const end = source.indexOf(ch, i + 1);
    if (end === -1) return null;
    return { value: source.slice(i + 1, end), end: end + 1 };
  }
  if (ch === "[") {
    const end = source.indexOf("]", i + 1);
    if (end === -1) return null;
    return { value: source.slice(i + 1, end), end: end + 1 };
  }
  const match = /^[A-Za-z_][\w$]*/.exec(source.slice(i));
  if (match === null) return null;
  return { value: match[0], end: i + match[0].length };
}

function readQualified(source: string, index: number): { parts: string[]; end: number } | null {
  const first = readIdent(source, index);
  if (first === null) return null;
  const parts = [first.value];
  let end = first.end;
  for (;;) {
    const dot = skipSpace(source, end);
    if (source[dot] !== ".") break;
    const next = readIdent(source, dot + 1);
    if (next === null) break;
    parts.push(next.value);
    end = next.end;
  }
  return { parts, end };
}

function readQuoted(source: string, index: number): { value: string; end: number } | null {
  const i = skipSpace(source, index);
  const quote = source[i];
  if (quote !== "'" && quote !== '"') return null;
  let value = "";
  let j = i + 1;
  while (j < source.length) {
    if (source[j] === quote && source[j + 1] === quote) {
      value += quote;
      j += 2;
      continue;
    }
    if (source[j] === quote) return { value, end: j + 1 };
    value += source[j];
    j += 1;
  }
  return null;
}

function readWrapped(source: string, index: number, open: string, close: string): { body: string; end: number } | null {
  const i = skipSpace(source, index);
  if (source[i] !== open) return null;
  let depth = 0;
  let quote: string | null = null;
  let j = i;
  while (j < source.length) {
    const ch = source[j];
    if (quote !== null) {
      if (ch === quote && source[j + 1] === quote) {
        j += 2;
        continue;
      }
      if (ch === quote) quote = null;
      j += 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      j += 1;
      continue;
    }
    if (ch === "-" && source[j + 1] === "-") {
      const nl = source.indexOf("\n", j);
      j = nl === -1 ? source.length : nl + 1;
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return { body: source.slice(i + 1, j), end: j + 1 };
    }
    j += 1;
  }
  return null;
}

function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let quote: string | null = null;
  let depth = 0;
  let start = 0;
  let j = 0;
  while (j < body.length) {
    const ch = body[j];
    if (quote !== null) {
      if (ch === quote && body[j + 1] === quote) {
        j += 2;
        continue;
      }
      if (ch === quote) quote = null;
      j += 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      j += 1;
      continue;
    }
    if (ch === "-" && body[j + 1] === "-") {
      const nl = body.indexOf("\n", j);
      j = nl === -1 ? body.length : nl + 1;
      continue;
    }
    if (ch === "(") depth += 1;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === "," && depth === 0) {
      let end = j;
      let k = j + 1;
      while (body[k] === " " || body[k] === "\t" || body[k] === "\r") k += 1;
      if (body.startsWith("--", k)) {
        const nl = body.indexOf("\n", k);
        end = nl === -1 ? body.length : nl;
      }
      parts.push(body.slice(start, end));
      start = end === j ? j + 1 : Math.min(body.length, end + 1);
      if (end !== j) j = end;
    }
    j += 1;
  }
  parts.push(body.slice(start));
  return parts;
}

function precedingComment(source: string, index: number): string {
  const lines = source.slice(0, index).split("\n");
  const collected: string[] = [];
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (line === "") continue;
    if (!line.startsWith("--")) break;
    collected.unshift(line.slice(2).trim());
  }
  return collected.join(" ");
}

function lineComment(piece: string): string {
  let quote: string | null = null;
  let j = 0;
  while (j < piece.length) {
    const ch = piece[j];
    if (quote !== null) {
      if (ch === quote && piece[j + 1] === quote) {
        j += 2;
        continue;
      }
      if (ch === quote) quote = null;
      j += 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      j += 1;
      continue;
    }
    if (ch === "-" && piece[j + 1] === "-") {
      const nl = piece.indexOf("\n", j);
      return piece.slice(j + 2, nl === -1 ? piece.length : nl).trim();
    }
    j += 1;
  }
  return "";
}

const CONSTRAINT_WORDS = new Set(["constraint", "primary", "unique", "check", "foreign", "key", "index", "fulltext"]);

function parseSql(text: string): SchemaDesign | null {
  if (!/create\s+table/i.test(text)) return null;
  const tables: TableNote[] = [];
  const createRe = /create\s+table\s+(?:if\s+not\s+exists\s+)?/gi;
  let match: RegExpExecArray | null;
  while ((match = createRe.exec(text)) !== null) {
    const name = readQualified(text, match.index + match[0].length);
    if (name === null) continue;
    const body = readWrapped(text, name.end, "(", ")");
    if (body === null) continue;
    tables.push(tableFromSql(name.parts, body.body, precedingComment(text, match.index)));
    createRe.lastIndex = body.end;
  }
  if (tables.length === 0) return null;
  applyCommentOn(text, tables);
  return { notes: "", tables };
}

function tableFromSql(path: readonly string[], body: string, lead: string): TableNote {
  let table = blankTable(path);
  if (lead !== "") table = { ...table, description: clip(lead, TEXT_CAP) };
  for (const piece of splitTopLevel(body)) {
    const ident = readIdent(piece, 0);
    if (ident === null) continue;
    if (CONSTRAINT_WORDS.has(ident.value.toLowerCase())) {
      table = foreignKeyPiece(table, piece);
      continue;
    }
    table = columnPiece(table, ident.value, piece);
  }
  return table;
}

function columnPiece(table: TableNote, name: string, piece: string): TableNote {
  const type = columnType(piece);
  let description = lineComment(piece);
  const commentAt = /\bcomment\b/i.exec(piece);
  if (commentAt !== null) {
    const quoted = readQuoted(piece, commentAt.index + commentAt[0].length);
    if (quoted !== null && quoted.value.trim() !== "") description = quoted.value;
  }
  const columns = description.trim() === "" ? table.columns : { ...table.columns, [name]: clip(description, TEXT_CAP) };
  const columnTypes = type === "" ? table.columnTypes : { ...table.columnTypes, [name]: type };
  let next: TableNote = { ...table, columns, columnTypes };
  const references = /\breferences\b/i.exec(piece);
  if (references !== null) next = referenceFrom(next, name, piece, references.index + references[0].length);
  return next;
}

function columnType(piece: string): string {
  const name = readIdent(piece, 0);
  if (name === null) return "";
  const type = readIdent(piece, name.end);
  if (type === null) return "";
  const paren = readWrapped(piece, type.end, "(", ")");
  return paren === null ? type.value : `${type.value}(${paren.body.trim()})`;
}

function foreignKeyPiece(table: TableNote, piece: string): TableNote {
  if (!/^\s*foreign\b/i.test(piece) && !/\bforeign\s+key\b/i.test(piece)) return table;
  const cols = readWrapped(piece, piece.toLowerCase().indexOf("key") + 3, "(", ")");
  const references = /\breferences\b/i.exec(piece);
  if (cols === null || references === null) return table;
  const fromColumns = splitTopLevel(cols.body)
    .map((part) => readIdent(part, 0)?.value ?? "")
    .filter((part) => part !== "");
  let next = table;
  for (const fromColumn of fromColumns)
    next = referenceFrom(next, fromColumn, piece, references.index + references[0].length);
  return next;
}

function referenceFrom(table: TableNote, fromColumn: string, piece: string, index: number): TableNote {
  const target = readQualified(piece, index);
  if (target === null || target.parts.length === 0) return table;
  const paren = readWrapped(piece, target.end, "(", ")");
  const toColumn = paren === null ? "" : (readIdent(paren.body, 0)?.value ?? "");
  if (toColumn === "") return table;
  const toTable = target.parts.join(".");
  return rememberRelationship(table, { fromColumn, toTable, toColumn });
}

function applyCommentOn(text: string, tables: TableNote[]): void {
  const re = /comment\s+on\s+(table|column)\s+/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const name = readQualified(text, match.index + match[0].length);
    if (name === null) continue;
    const after = skipSpace(text, name.end);
    if (!/^is\b/i.test(text.slice(after))) continue;
    const quoted = readQuoted(text, after + 2);
    if (quoted === null) continue;
    const kind = match[1].toLowerCase();
    const path = kind === "table" ? name.parts : name.parts.slice(0, -1);
    const column = kind === "column" ? lastSegment(name.parts) : "";
    const index = tables.findIndex((table) => pathKey(table.path) === pathKey(path));
    if (index === -1) continue;
    const table = tables[index];
    tables[index] =
      kind === "table"
        ? { ...table, description: clip(quoted.value, TEXT_CAP) }
        : { ...table, columns: { ...table.columns, [column]: clip(quoted.value, TEXT_CAP) } };
    re.lastIndex = quoted.end;
  }
}

function parseDbml(text: string): SchemaDesign | null {
  if (!/\bTable\b/.test(text) || !text.includes("{")) return null;
  const tables: TableNote[] = [];
  const re = /\bTable\s+/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const name = readQualified(text, match.index + match[0].length);
    if (name === null) continue;
    const body = readWrapped(text, name.end, "{", "}");
    if (body === null) continue;
    tables.push(tableFromDbml(name.parts, body.body));
    re.lastIndex = body.end;
  }
  if (tables.length === 0) return null;
  applyDbmlRefs(text, tables);
  return { notes: "", tables };
}

function tableFromDbml(path: readonly string[], body: string): TableNote {
  let description = "";
  const columns: Record<string, string> = {};
  const columnTypes: Record<string, string> = {};
  let relationships: readonly RelationshipNote[] = [];
  const lines = body.split("\n");
  let depth = 0;
  for (const line of lines) {
    const opens = (line.match(/\{/g) ?? []).length;
    const closes = (line.match(/\}/g) ?? []).length;
    if (depth > 0) {
      depth += opens - closes;
      continue;
    }
    if (/^\s*indexes\b/i.test(line)) {
      depth += opens - closes;
      continue;
    }
    if (/^\s*Note\s*:/i.test(line)) {
      const quoted = readQuoted(line, line.indexOf(":") + 1);
      if (quoted !== null) description = clip(quoted.value, TEXT_CAP);
      continue;
    }
    const column = dbmlColumn(line);
    if (column === null) continue;
    if (column.note !== "") columns[column.name] = clip(column.note, TEXT_CAP);
    columnTypes[column.name] = column.type;
    if (column.ref !== null) {
      relationships = rememberRelationship(
        { path, description, endorsement: "normal", columns, columnTypes, relationships },
        { fromColumn: column.name, ...column.ref },
      ).relationships;
    }
  }
  return { path, description, endorsement: "normal", columns, columnTypes, relationships };
}

function dbmlColumn(
  line: string,
): { name: string; type: string; note: string; ref: { toTable: string; toColumn: string } | null } | null {
  const trimmed = line.trim();
  if (trimmed === "" || trimmed.startsWith("//")) return null;
  const name = readIdent(trimmed, 0);
  if (name === null) return null;
  const type = readIdent(trimmed, name.end);
  if (type === null) return null;
  let typeName = type.value;
  let end = type.end;
  const paren = readWrapped(trimmed, end, "(", ")");
  if (paren !== null) {
    typeName = `${typeName}(${paren.body.trim()})`;
    end = paren.end;
  }
  let note = "";
  const noteAt = trimmed.toLowerCase().indexOf("note:");
  if (noteAt !== -1) {
    const quoted = readQuoted(trimmed, noteAt + "note:".length);
    if (quoted !== null) note = quoted.value;
  }
  let ref: { toTable: string; toColumn: string } | null = null;
  const refAt = /ref\s*:/i.exec(trimmed.slice(end));
  if (refAt !== null) {
    const target = /[>-]\s*([A-Za-z_][\w$.]*)/.exec(trimmed.slice(end + refAt.index + refAt[0].length));
    if (target !== null) {
      const parts = target[1].split(".").filter((part) => part !== "");
      const toColumn = parts.pop() ?? "";
      if (toColumn !== "" && parts.length > 0) ref = { toTable: parts.join("."), toColumn };
    }
  }
  return { name: name.value, type: typeName, note, ref };
}

function applyDbmlRefs(text: string, tables: TableNote[]): void {
  const re = /^\s*Ref\s*:\s*(\S+)\s*[>-]\s*(\S+)/gim;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const from = match[1].split(".").filter((part) => part !== "");
    const to = match[2].split(".").filter((part) => part !== "");
    const fromColumn = from.pop() ?? "";
    const toColumn = to.pop() ?? "";
    if (fromColumn === "" || toColumn === "" || from.length === 0 || to.length === 0) continue;
    const index = tables.findIndex((table) => pathKey(table.path) === pathKey(from));
    if (index === -1) continue;
    tables[index] = rememberRelationship(tables[index], { fromColumn, toTable: to.join("."), toColumn });
  }
}

function parseJsonDesign(text: string): SchemaDesign | null | "syntax" {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return "syntax";
  }
  if (Array.isArray(value)) {
    const tables = value.map(tableFromJson).filter((table): table is TableNote => table !== null);
    return { notes: "", tables };
  }
  if (!isRecord(value)) return null;
  if (Array.isArray(value.schema) && !Array.isArray(value.tables)) {
    const tables = value.schema.map(tableFromSnapshot).filter((table): table is TableNote => table !== null);
    return { notes: typeof value.notes === "string" ? clip(value.notes, NOTES_CAP) : "", tables };
  }
  if (!Array.isArray(value.tables) && typeof value.notes !== "string") return null;
  const tables = Array.isArray(value.tables)
    ? value.tables.map(tableFromJson).filter((table): table is TableNote => table !== null)
    : [];
  return { notes: typeof value.notes === "string" ? clip(value.notes, NOTES_CAP) : "", tables };
}

function tableFromSnapshot(value: unknown): TableNote | null {
  if (!isRecord(value)) return null;
  const path = pathOf(value);
  if (path === null) return null;
  const columnTypes: Record<string, string> = {};
  if (Array.isArray(value.columns)) {
    for (const column of value.columns) {
      if (!isRecord(column) || typeof column.name !== "string" || column.name.trim() === "") continue;
      columnTypes[column.name] = typeof column.type === "string" && column.type.trim() !== "" ? column.type : "unknown";
    }
  }
  return { ...blankTable(path), columnTypes };
}

function tableFromJson(value: unknown): TableNote | null {
  if (!isRecord(value)) return null;
  const path = pathOf(value);
  if (path === null) return null;
  const columns: Record<string, string> = {};
  const columnTypes: Record<string, string> = {};
  if (isRecord(value.columns)) {
    for (const [name, description] of Object.entries(value.columns)) {
      if (typeof description === "string" && description.trim() !== "") columns[name] = clip(description, TEXT_CAP);
    }
  } else if (Array.isArray(value.columns)) {
    for (const column of value.columns) {
      if (!isRecord(column) || typeof column.name !== "string" || column.name.trim() === "") continue;
      if (typeof column.description === "string" && column.description.trim() !== "") {
        columns[column.name] = clip(column.description, TEXT_CAP);
      }
      if (typeof column.type === "string" && column.type.trim() !== "") columnTypes[column.name] = column.type;
    }
  }
  const relationships: RelationshipNote[] = [];
  if (Array.isArray(value.relationships)) {
    for (const rel of value.relationships) {
      if (!isRecord(rel)) continue;
      if (typeof rel.fromColumn !== "string" || typeof rel.toTable !== "string" || typeof rel.toColumn !== "string") {
        continue;
      }
      if (rel.fromColumn.trim() === "" || rel.toTable.trim() === "" || rel.toColumn.trim() === "") continue;
      relationships.push({ fromColumn: rel.fromColumn, toTable: rel.toTable, toColumn: rel.toColumn });
    }
  }
  return {
    path,
    description: typeof value.description === "string" ? clip(value.description, TEXT_CAP) : "",
    endorsement: endorsementOf(value.endorsement),
    columns,
    columnTypes,
    relationships,
  };
}

function pathOf(value: Record<string, unknown>): string[] | null {
  const listed = stringList(value.path);
  if (listed !== null) return listed;
  if (typeof value.name !== "string") return null;
  const parts = value.name
    .split(".")
    .map((part) => part.trim())
    .filter((part) => part !== "");
  return parts.length === 0 ? null : parts;
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const parts: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.trim() === "") return null;
    parts.push(item);
  }
  return parts;
}
