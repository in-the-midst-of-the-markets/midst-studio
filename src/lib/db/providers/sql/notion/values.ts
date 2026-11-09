/**
 * One Notion property value as a cell.
 *
 * A page body is a tree of blocks, and this reader never asks for it. A property
 * becomes a string, a number, a boolean, or null. People, relations and rollups
 * come back as text.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function plainText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value.map((item) => (isRecord(item) && typeof item.plain_text === "string" ? item.plain_text : "")).join("");
}

function names(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((item) => {
      if (!isRecord(item)) return "";
      if (typeof item.name === "string" && item.name !== "") return item.name;
      if (typeof item.id === "string") return item.id;
      return "";
    })
    .filter((item) => item !== "")
    .join(", ");
}

function fileNames(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((item) => {
      if (!isRecord(item)) return "";
      if (typeof item.name === "string" && item.name !== "") return item.name;
      if (isRecord(item.file) && typeof item.file.url === "string") return item.file.url;
      if (isRecord(item.external) && typeof item.external.url === "string") return item.external.url;
      return "";
    })
    .filter((item) => item !== "")
    .join(", ");
}

function dateText(value: unknown): string | null {
  if (!isRecord(value) || typeof value.start !== "string") return null;
  return typeof value.end === "string" && value.end !== "" ? `${value.start}/${value.end}` : value.start;
}

function formulaCell(value: unknown): unknown {
  if (!isRecord(value) || typeof value.type !== "string") return null;
  if (value.type === "string") return typeof value.string === "string" ? value.string : null;
  if (value.type === "number") return typeof value.number === "number" ? value.number : null;
  if (value.type === "boolean") return typeof value.boolean === "boolean" ? value.boolean : null;
  if (value.type === "date") return dateText(value.date);
  return null;
}

function rollupCell(value: unknown): unknown {
  if (!isRecord(value) || typeof value.type !== "string") return null;
  if (value.type === "number") return typeof value.number === "number" ? value.number : null;
  if (value.type === "date") return dateText(value.date);
  if (value.type === "array") return Array.isArray(value.array) ? names(value.array) || plainText(value.array) : null;
  return null;
}

function uniqueId(value: unknown): string | number | null {
  if (!isRecord(value) || typeof value.number !== "number") return null;
  return typeof value.prefix === "string" && value.prefix !== "" ? `${value.prefix}-${value.number}` : value.number;
}

function person(value: unknown): string | null {
  if (!isRecord(value)) return null;
  if (typeof value.name === "string" && value.name !== "") return value.name;
  return typeof value.id === "string" ? value.id : null;
}

/** The cell for one property object, or null when Notion left it empty. */
export function notionCell(property: unknown): unknown {
  if (!isRecord(property) || typeof property.type !== "string") return null;
  const value = property[property.type];
  switch (property.type) {
    case "title":
    case "rich_text":
      return plainText(value);
    case "number":
      return typeof value === "number" ? value : null;
    case "select":
    case "status":
      return isRecord(value) && typeof value.name === "string" ? value.name : null;
    case "multi_select":
      return names(value);
    case "date":
      return dateText(value);
    case "people":
    case "relation":
      return names(value);
    case "files":
      return fileNames(value);
    case "checkbox":
      return typeof value === "boolean" ? value : null;
    case "url":
    case "email":
    case "phone_number":
    case "created_time":
    case "last_edited_time":
      return typeof value === "string" ? value : null;
    case "formula":
      return formulaCell(value);
    case "rollup":
      return rollupCell(value);
    case "unique_id":
      return uniqueId(value);
    case "created_by":
    case "last_edited_by":
      return person(value);
    case "verification":
      return isRecord(value) && typeof value.state === "string" ? value.state : null;
    default:
      return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean"
        ? value
        : null;
  }
}

/** The title Notion stores as rich text, joined into one string. */
export function notionTitle(value: unknown): string {
  return plainText(value).trim();
}
