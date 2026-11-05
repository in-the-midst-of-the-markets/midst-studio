import { parseUntrustedYaml } from "@/lib/dbt/yaml";
import type { GitFile } from "@/lib/git/github";

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface DbtModel {
  readonly name: string;
  readonly path: string;
  readonly sql: string;
  readonly refs: readonly string[];
  readonly sources: readonly DbtSourceRef[];
}

export interface DbtSourceRef {
  readonly source: string;
  readonly table: string;
}

export interface DbtProject {
  readonly name: string;
  readonly models: readonly DbtModel[];
}

/** The models in a fetched project. A problem is a sentence. */
export function readDbtProject(files: readonly GitFile[]): DbtProject | string {
  const project = files.find((file) => file.path === "dbt_project.yml");
  if (project === undefined) return "This repository has no dbt_project.yml.";
  let parsed: unknown;
  try {
    parsed = parseUntrustedYaml(project.text);
  } catch {
    return "dbt_project.yml could not be read.";
  }
  const record = asRecord(parsed);
  const name = record?.name;
  if (typeof name !== "string" || !IDENT.test(name)) return "dbt_project.yml needs a project name.";
  const models: DbtModel[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    if (!file.path.endsWith(".sql")) continue;
    const modelName =
      file.path
        .split("/")
        .pop()
        ?.replace(/\.sql$/, "") ?? "";
    if (!IDENT.test(modelName)) return `A model file is not named as a model: ${file.path}.`;
    if (seen.has(modelName)) return `Two models are named ${modelName}.`;
    seen.add(modelName);
    models.push({
      name: modelName,
      path: file.path,
      sql: file.text,
      refs: refsIn(file.text),
      sources: sourcesIn(file.text),
    });
  }
  return { name, models };
}

const REF = /{{\s*ref\(\s*(?:['"][A-Za-z0-9_]+['"]\s*,\s*)?['"]([A-Za-z0-9_]+)['"]\s*\)\s*}}/g;
const SOURCE = /{{\s*source\(\s*['"]([A-Za-z0-9_]+)['"]\s*,\s*['"]([A-Za-z0-9_]+)['"]\s*\)\s*}}/g;

export function refsIn(sql: string): string[] {
  return [...sql.matchAll(REF)].map((match) => match[1] ?? "").filter((name) => name !== "");
}

export function sourcesIn(sql: string): DbtSourceRef[] {
  return [...sql.matchAll(SOURCE)].flatMap((match) => {
    const source = match[1];
    const table = match[2];
    return source !== undefined && table !== undefined ? [{ source, table }] : [];
  });
}

/**
 * Replaces `ref` and `source` with relation names.
 * Other Jinja is left as written, and `unresolved` says so.
 */
export function previewModel(
  sql: string,
  schema: string,
  sourceSchemas: ReadonlyMap<string, string>,
): { sql: string; unresolved: boolean } {
  const relation = IDENT.test(schema) ? schema : "public";
  const replaced = sql
    .replace(REF, (_match, name: string) => `${relation}.${name}`)
    .replace(SOURCE, (_match, source: string, table: string) => {
      const sourceSchema = sourceSchemas.get(source);
      const used = sourceSchema !== undefined && IDENT.test(sourceSchema) ? sourceSchema : source;
      return `${used}.${table}`;
    });
  return { sql: replaced, unresolved: replaced.includes("{{") };
}

/** Schema named for a source in the project YAML, keyed by source name. */
export function sourceSchemas(files: readonly GitFile[]): Map<string, string> {
  const schemas = new Map<string, string>();
  for (const file of files) {
    if (!/\.ya?ml$/.test(file.path) || file.path === "dbt_project.yml") continue;
    let parsed: unknown;
    try {
      parsed = parseUntrustedYaml(file.text);
    } catch {
      continue;
    }
    const sources = asRecord(parsed)?.sources;
    if (!Array.isArray(sources)) continue;
    for (const source of sources) {
      const row = asRecord(source);
      const name = row?.name;
      const schema = row?.schema;
      if (typeof name === "string" && typeof schema === "string" && IDENT.test(name) && IDENT.test(schema)) {
        schemas.set(name, schema);
      }
    }
  }
  return schemas;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
