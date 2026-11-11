/**
 * The SQL subset a Microsoft Excel connection runs.
 *
 * Excel is a workbook, not a SQL server. The editor still speaks SQL, and this module
 * turns one SELECT into one worksheet. The worksheet's name is whatever the workbook
 * calls it, once spaces and punctuation are folded into a single word. Filters, order
 * and the page are applied to the cells Studio read. A write, a join and a second
 * statement fail here, before a request.
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
export const EXCEL_ROW_CAP = 500;
/** How many columns one statement reads, A through Z. */
export const EXCEL_COLUMN_CAP = 26;
/** How many worksheets the object tree shows. */
export const EXCEL_SHEET_CAP = 20;

const PROVIDER = "excel" as const;

export type ExcelColumn = ListedColumn;
export type ExcelSelect = ListedSelect;

export interface ExcelSheet {
  readonly key: string;
  readonly id: string;
}

const EXCEL: ListedProduct = {
  provider: PROVIDER,
  rowCap: EXCEL_ROW_CAP,
  resources: [],
  product: "Microsoft Excel",
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

/** One statement. The worksheet and the fields are checked against the workbook after this returns. */
export function translateExcelSql(sql: string): ExcelSelect {
  return translateListedSql(sql, EXCEL);
}

/**
 * The name Studio uses for a worksheet or a header. Spaces and punctuation become
 * underscores. A name that does not start with a letter is prefixed. A name already
 * taken gains a numeric suffix.
 */
export function excelKey(raw: string, index: number, used: ReadonlySet<string>, empty: string): string {
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

/** The worksheets Graph returned, skipping a sheet that is hidden. */
export function excelSheets(body: unknown): ExcelSheet[] {
  if (!isRecord(body) || !Array.isArray(body.value)) fail("Microsoft Excel's answer was not a list.");
  const used = new Set<string>();
  const sheets: ExcelSheet[] = [];
  for (const item of body.value) {
    if (!isRecord(item)) fail("Microsoft Excel's answer was not a list.");
    if (item.visibility === "Hidden" || item.visibility === "VeryHidden") continue;
    if (typeof item.id !== "string" || item.id === "" || typeof item.name !== "string") {
      fail("Microsoft Excel's answer was not a list.");
    }
    const key = excelKey(item.name, sheets.length + 1, used, "sheet");
    used.add(key);
    sheets.push({ key, id: item.id });
    if (sheets.length >= EXCEL_SHEET_CAP) break;
  }
  return sheets;
}

/** Column names from the first row of a range. A blank header at the end is dropped. */
export function excelColumns(cells: readonly unknown[]): ExcelColumn[] {
  const bounded = cells.slice(0, EXCEL_COLUMN_CAP);
  const used = new Set<string>();
  const columns: ExcelColumn[] = [];
  for (let index = 0; index < bounded.length; index += 1) {
    const cell = bounded[index];
    const raw = typeof cell === "string" ? cell : "";
    const name = excelKey(raw, index + 1, used, "column_");
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

export interface ExcelGrid {
  readonly columns: readonly ExcelColumn[];
  readonly entries: readonly Record<string, unknown>[];
  /** The range filled the row cap or the column cap, so another page was not read. */
  readonly more: boolean;
}

/** The `text` grid Graph returns for one range. The first row is the header. */
export function excelGrid(body: unknown): ExcelGrid {
  if (!isRecord(body) || !Array.isArray(body.text) || body.text.length === 0 || !Array.isArray(body.text[0])) {
    fail("Microsoft Excel's answer was not a list.");
  }
  const header = body.text[0] as readonly unknown[];
  const columns = excelColumns(header);
  const entries: Record<string, unknown>[] = [];
  for (const row of body.text.slice(1, EXCEL_ROW_CAP + 1)) {
    if (!Array.isArray(row)) fail("Microsoft Excel's answer was not a list.");
    const record: Record<string, unknown> = {};
    for (let index = 0; index < columns.length; index += 1) {
      const column = columns[index] as ExcelColumn;
      record[column.json] = cellText(row[index]);
    }
    entries.push(record);
  }
  const more = body.text.length - 1 >= EXCEL_ROW_CAP || header.length >= EXCEL_COLUMN_CAP;
  return { columns, entries, more };
}

function missing(name: string, table: string, sql: string): never {
  throw new QueryError(`Microsoft Excel has no field named ${name} on ${table}.`, PROVIDER, sql);
}

/** The page of rows one worksheet becomes, after the header has named the fields. */
export function excelRows(
  statement: ExcelSelect,
  columns: readonly ExcelColumn[],
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
    columns,
    primary: columns[0]?.name ?? statement.resource.primary,
  };
  return listedRows(EXCEL, { ...statement, resource }, entries, sql);
}
