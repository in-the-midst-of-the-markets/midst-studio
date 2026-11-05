import { parseUntrustedYaml } from "@/lib/dbt/yaml";
import type { GitFile } from "@/lib/git/github";

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED = new Set([
  "select",
  "from",
  "where",
  "union",
  "insert",
  "update",
  "delete",
  "drop",
  "alter",
  "create",
  "grant",
  "into",
  "join",
  "with",
  "copy",
  "call",
  "execute",
  "table",
  "values",
]);

export interface MetricModel {
  readonly name: string;
  readonly relation: string;
  readonly timeDimension: string | null;
  readonly measures: readonly MetricMeasure[];
}

export interface MetricMeasure {
  readonly name: string;
  readonly agg: string;
  readonly expr: string;
}

export interface ProjectMetric {
  readonly name: string;
  readonly label: string;
  readonly sql: string | null;
  readonly reason: string | null;
  readonly timeDimension: string | null;
}

const AGG: Readonly<Record<string, (expr: string) => string>> = {
  sum: (expr) => `SUM(${expr})`,
  avg: (expr) => `AVG(${expr})`,
  min: (expr) => `MIN(${expr})`,
  max: (expr) => `MAX(${expr})`,
  count: (expr) => (expr === "*" ? "COUNT(*)" : `COUNT(${expr})`),
  count_distinct: (expr) => `COUNT(DISTINCT ${expr})`,
};

/** The MetricFlow metrics declared beside the models, each with the SQL a chart can run. */
export function readMetrics(files: readonly GitFile[], schema: string): ProjectMetric[] {
  const models = semanticModels(files, schema);
  const metrics: ProjectMetric[] = [];
  for (const file of files) {
    if (!/\.ya?ml$/.test(file.path)) continue;
    let parsed: unknown;
    try {
      parsed = parseUntrustedYaml(file.text);
    } catch {
      continue;
    }
    const listed = asRecord(parsed)?.metrics;
    if (!Array.isArray(listed)) continue;
    for (const item of listed) {
      const metric = oneMetric(item, models);
      if (metric !== null) metrics.push(metric);
    }
  }
  return metrics;
}

function semanticModels(files: readonly GitFile[], schema: string): Map<string, MetricModel> {
  const models = new Map<string, MetricModel>();
  for (const file of files) {
    if (!/\.ya?ml$/.test(file.path)) continue;
    let parsed: unknown;
    try {
      parsed = parseUntrustedYaml(file.text);
    } catch {
      continue;
    }
    const listed = asRecord(parsed)?.semantic_models;
    if (!Array.isArray(listed)) continue;
    for (const item of listed) {
      const model = oneModel(item, schema);
      if (model !== null) models.set(model.name, model);
    }
  }
  return models;
}

function oneModel(value: unknown, schema: string): MetricModel | null {
  const row = asRecord(value);
  const name = row?.name;
  const relation = relationOf(row?.model, schema);
  if (typeof name !== "string" || !IDENT.test(name) || relation === null) return null;
  const defaults = asRecord(row?.defaults);
  const time = defaults?.agg_time_dimension;
  const measures: MetricMeasure[] = [];
  if (Array.isArray(row?.measures)) {
    for (const measure of row.measures) {
      const parsed = oneMeasure(measure);
      if (parsed !== null) measures.push(parsed);
    }
  }
  return {
    name,
    relation,
    timeDimension: typeof time === "string" && IDENT.test(time) ? time : null,
    measures,
  };
}

function oneMeasure(value: unknown): MetricMeasure | null {
  const row = asRecord(value);
  const name = row?.name;
  const agg = row?.agg;
  if (typeof name !== "string" || !IDENT.test(name) || typeof agg !== "string" || AGG[agg] === undefined) return null;
  const expr = row?.expr;
  const column = expr === undefined ? name : expr;
  if (typeof column !== "string") return null;
  const safe = metricExpression(column);
  if (safe === null) return null;
  return { name, agg, expr: safe };
}

/** A column expression a chart can run. Words that start a statement are refused. */
function metricExpression(expr: string): string | null {
  const trimmed = expr.trim();
  if (trimmed.length === 0 || trimmed.length > 200) return null;
  if (trimmed === "*") return "*";
  if (!/^[A-Za-z0-9_+\-*/(). ]+$/.test(trimmed)) return null;
  if (/[A-Za-z_][A-Za-z0-9_]*\s*\(/.test(trimmed)) return null;
  const words = trimmed.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
  if (words.length === 0) return null;
  if (words.some((word) => RESERVED.has(word.toLowerCase()))) return null;
  let depth = 0;
  for (const char of trimmed) {
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    if (depth < 0) return null;
  }
  if (depth !== 0) return null;
  return trimmed.replace(/\s+/g, " ");
}

function oneMetric(value: unknown, models: ReadonlyMap<string, MetricModel>): ProjectMetric | null {
  const row = asRecord(value);
  const name = row?.name;
  if (typeof name !== "string" || !IDENT.test(name)) return null;
  const offered = typeof row?.label === "string" ? row.label.trim() : "";
  const label = offered !== "" && offered.length <= 200 ? offered : name;
  const type = row?.type;
  const params = asRecord(row?.type_params);
  if (type === "simple") return simpleMetric(name, label, params, models);
  if (type === "ratio") return ratioMetric(name, label, params, models);
  return { name, label, sql: null, reason: "Only simple and ratio metrics can be charted.", timeDimension: null };
}

function simpleMetric(
  name: string,
  label: string,
  params: Record<string, unknown> | null,
  models: ReadonlyMap<string, MetricModel>,
): ProjectMetric {
  const found = measureOf(params?.measure, models);
  if (found === null)
    return { name, label, sql: null, reason: "This metric does not name a measure.", timeDimension: null };
  return {
    name,
    label,
    sql: selectMetric(found.model, name, found.call),
    reason: null,
    timeDimension: found.model.timeDimension,
  };
}

function ratioMetric(
  name: string,
  label: string,
  params: Record<string, unknown> | null,
  models: ReadonlyMap<string, MetricModel>,
): ProjectMetric {
  const numerator = measureOf(params?.numerator, models);
  const denominator = measureOf(params?.denominator, models);
  if (numerator === null || denominator === null) {
    return { name, label, sql: null, reason: "This ratio does not name two measures.", timeDimension: null };
  }
  if (numerator.model.name !== denominator.model.name) {
    return { name, label, sql: null, reason: "This ratio uses measures from two models.", timeDimension: null };
  }
  return {
    name,
    label,
    sql: selectMetric(numerator.model, name, `${numerator.call} / NULLIF(${denominator.call}, 0)`),
    reason: null,
    timeDimension: numerator.model.timeDimension,
  };
}

function selectMetric(model: MetricModel, name: string, expression: string): string {
  if (model.timeDimension === null) {
    return `SELECT 'all' AS bucket, ${expression} AS ${name}\nFROM ${model.relation}`;
  }
  return `SELECT ${model.timeDimension}, ${expression} AS ${name}\nFROM ${model.relation}\nGROUP BY ${model.timeDimension}\nORDER BY ${model.timeDimension}`;
}

interface FoundMeasure {
  readonly model: MetricModel;
  readonly call: string;
}

function measureOf(value: unknown, models: ReadonlyMap<string, MetricModel>): FoundMeasure | null {
  const name = typeof value === "string" ? value : asRecord(value)?.name;
  if (typeof name !== "string") return null;
  for (const model of models.values()) {
    const measure = model.measures.find((item) => item.name === name);
    const agg = measure === undefined ? undefined : AGG[measure.agg];
    if (measure !== undefined && agg !== undefined) return { model, call: agg(measure.expr) };
  }
  return null;
}

function relationOf(value: unknown, schema: string): string | null {
  if (typeof value !== "string") return null;
  const match = value.match(/ref\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\)/);
  const name = match?.[1];
  const used = IDENT.test(schema) ? schema : "public";
  return name === undefined ? null : `${used}.${name}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
