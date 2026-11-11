/**
 * The SQL subset a Google Sheets connection runs.
 *
 * Google Sheets is a spreadsheet, not a SQL server. The editor still speaks SQL, and
 * this module turns one SELECT into one worksheet. The worksheet's name is whatever
 * the spreadsheet calls it, once spaces and punctuation are folded into a single word.
 * Filters, order and the page are applied to the cells Studio read. A write, a join
 * and a second statement fail here, before a request.
 */
import { QueryError } from "@/lib/db/errors";
import {
  listedRows,
  translateListedSql,
  type ListedColumn,
  type ListedProduct,
  type ListedResource,
  type ListedSelect,
} from "../listed-select";

/** How many data rows one statement reads. The header row is not one of them. */
export const SHEETS_ROW_CAP = 500;
/** How many columns one statement reads, A through Z. */
export const SHEETS_COLUMN_CAP = 26;
/** How many worksheets the object tree shows. */
export const SHEETS_TAB_CAP = 20;

const PROVIDER = "googlesheets" as const;

export type SheetsColumn = ListedColumn;
export type SheetsSelect = ListedSelect;

export interface SheetsTab {
  readonly key: string;
  readonly title: string;
  readonly id: string;
}

const SHEETS: ListedProduct = {
  provider: PROVIDER,
  rowCap: SHEETS_ROW_CAP,
  resources: [],
  product: "Google Sheets",
  example: "sheet1",
  exampleColumn: "name",
  acceptAnyName: true,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new QueryError(message, PROVIDER);
}

/** One statement. The worksheet and the fields are checked against the spreadsheet after this returns. */
export function translateSheetsSql(sql: string): SheetsSelect {
  return translateListedSql(sql, SHEETS);
}

/**
 * The name Studio uses for a worksheet or a header. Spaces and punctuation become
 * underscores. A name that does not start with a letter is prefixed. A name already
 * taken gains a numeric suffix.
 */
export function sheetsKey(raw: string, index: number, used: ReadonlySet<string>, empty: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
  const stemmed = cleaned.length > 0 && /^[a-z_]/.test(cleaned) ? cleaned : `${empty}${index}`;
  const stem = stemmed.slice(0, 60);
  let key = stem;
  let n = 2;
  while (used.has(key)) {
    const suffix = `_${n}`;
    key = `${stem.slice(0, 60 - suffix.length)}${suffix}`;
    n += 1;
  }
  return key;
}

/** The worksheets the spreadsheet returned, skipping a sheet that is hidden. */
export function sheetsTabs(body: unknown): SheetsTab[] {
  if (!isRecord(body) || !Array.isArray(body.sheets)) fail("Google Sheets' answer was not a list.");
  const used = new Set<string>();
  const tabs: SheetsTab[] = [];
  for (const item of body.sheets) {
    if (!isRecord(item) || !isRecord(item.properties)) fail("Google Sheets' answer was not a list.");
    const properties = item.properties;
    if (properties.hidden === true) continue;
    if (
      typeof properties.title !== "string" ||
      typeof properties.sheetId !== "number" ||
      !Number.isInteger(properties.sheetId)
    ) {
      fail("Google Sheets' answer was not a list.");
    }
    const key = sheetsKey(properties.title, tabs.length + 1, used, "sheet");
    used.add(key);
    tabs.push({ key, title: properties.title, id: String(properties.sheetId) });
    if (tabs.length >= SHEETS_TAB_CAP) break;
  }
  return tabs;
}

/** Column names from the first row of a range. A blank header at the end is dropped. */
export function sheetsColumns(cells: readonly unknown[]): SheetsColumn[] {
  const bounded = cells.slice(0, SHEETS_COLUMN_CAP);
  const used = new Set<string>();
  const columns: SheetsColumn[] = [];
  for (let index = 0; index < bounded.length; index += 1) {
    const cell = bounded[index];
    const raw = typeof cell === "string" ? cell : "";
    const name = sheetsKey(raw, index + 1, used, "column_");
    used.add(name);
    columns.push({ name, type: "text", json: name });
  }
  while (columns.length > 0) {
    const cell = bounded[columns.length - 1];
    const blank = cell === null || cell === undefined || (typeof cell === "string" && cell.trim() === "");
    if (!blank) break;
    columns.pop();
  }
  if (columns.length === 0) return [{ name: "column_1", type: "text", json: "column_1" }];
  return columns;
}

function cellText(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

export interface SheetsGrid {
  readonly columns: readonly SheetsColumn[];
  readonly entries: readonly Record<string, unknown>[];
  /** The range filled the row cap or the column cap, so another page was not read. */
  readonly more: boolean;
}

/** The formatted values one range returns. The first row is the header. A sheet with no cells is one empty column. */
export function sheetsGrid(body: unknown): SheetsGrid {
  if (!isRecord(body)) fail("Google Sheets' answer was not a list.");
  if (body.values === undefined) {
    return { columns: sheetsColumns([]), entries: [], more: false };
  }
  if (!Array.isArray(body.values) || body.values.length === 0 || !Array.isArray(body.values[0])) {
    fail("Google Sheets' answer was not a list.");
  }
  const header = body.values[0] as readonly unknown[];
  const columns = sheetsColumns(header);
  const entries: Record<string, unknown>[] = [];
  for (const row of body.values.slice(1, SHEETS_ROW_CAP + 1)) {
    if (!Array.isArray(row)) fail("Google Sheets' answer was not a list.");
    const record: Record<string, unknown> = {};
    for (let index = 0; index < columns.length; index += 1) {
      const column = columns[index] as SheetsColumn;
      record[column.json] = cellText(row[index]);
    }
    entries.push(record);
  }
  const more = body.values.length - 1 >= SHEETS_ROW_CAP || header.length >= SHEETS_COLUMN_CAP;
  return { columns, entries, more };
}

function missing(name: string, table: string, sql: string): never {
  throw new QueryError(`Google Sheets has no field named ${name} on ${table}.`, PROVIDER, sql);
}

/** The page of rows one worksheet becomes, after the header has named the fields. */
export function sheetsRows(
  statement: SheetsSelect,
  columns: readonly SheetsColumn[],
  entries: readonly Record<string, unknown>[],
  sql: string,
): Record<string, unknown>[] {
  const names = new Set(columns.map((column) => column.name));
  for (const name of statement.columns ?? []) {
    if (!names.has(name)) missing(name, statement.resource.name, sql);
  }
  for (const filter of statement.filters) {
    if (!names.has(filter.field)) missing(filter.field, statement.resource.name, sql);
  }
  if (statement.orderBy !== null && !names.has(statement.orderBy.column)) {
    missing(statement.orderBy.column, statement.resource.name, sql);
  }
  const resource: ListedResource = {
    ...statement.resource,
    columns: [...columns],
    primary: columns[0]?.name ?? statement.resource.primary,
  };
  return listedRows(SHEETS, { ...statement, resource }, entries, sql);
}
