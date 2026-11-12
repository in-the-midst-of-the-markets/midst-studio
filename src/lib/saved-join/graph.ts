/**
 * The property graph a saved join builds over the tables it loaded.
 *
 * DuckPGQ reads real tables, not views. An edge whose endpoints live on a saved query
 * is copied into the `graph` schema, and the graph is named `saved`. A table with an
 * `id` column is a vertex. An edge is either a table that already has both ends
 * (`src`/`dst`, `source`/`target`, `source_id`/`target_id`, or `from_id`/`to_id`) and
 * exactly one other vertex to attach them to, or a column named `<other>_id` whose
 * stem is another loaded query that has an `id`.
 */

export interface GraphColumnTable {
  readonly name: string;
  readonly fields: readonly string[];
}

interface EdgeSpec {
  readonly label: string;
  readonly source: string;
  readonly target: string;
  readonly from: string;
  readonly sourceColumn: string;
  readonly targetColumn: string;
}

const ENDPOINT_PAIRS: readonly (readonly [string, string])[] = [
  ["src", "dst"],
  ["source", "target"],
  ["source_id", "target_id"],
  ["from_id", "to_id"],
];

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function fieldsOf(table: GraphColumnTable): Map<string, string> {
  const fields = new Map<string, string>();
  for (const field of table.fields) fields.set(field.toLowerCase(), field);
  return fields;
}

function hasId(table: GraphColumnTable): boolean {
  return fieldsOf(table).has("id");
}

/** Saved queries a loaded table points at by a `<name>_id` column, matched case-insensitively. */
export function linkedQueryNames(fields: readonly string[], available: readonly string[]): string[] {
  const byFold = new Map(available.map((name) => [name.toLowerCase(), name]));
  const linked: string[] = [];
  const seen = new Set<string>();
  for (const field of fields) {
    const match = field.toLowerCase().match(/^(.*)_id$/u);
    const stem = match?.[1];
    if (stem === undefined || stem === "" || stem === "source" || stem === "target" || stem === "from") continue;
    const name = byFold.get(stem) ?? byFold.get(`${stem}s`);
    if (name === undefined || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    linked.push(name);
  }
  return linked;
}

function directEdge(table: GraphColumnTable, vertices: readonly GraphColumnTable[]): EdgeSpec | null {
  const fields = fieldsOf(table);
  const pair = ENDPOINT_PAIRS.find(([source, target]) => fields.has(source) && fields.has(target));
  if (pair === undefined) return null;
  const others = vertices.filter((vertex) => vertex.name.toLowerCase() !== table.name.toLowerCase());
  if (others.length !== 1) return null;
  const vertex = others[0] as GraphColumnTable;
  const sourceColumn = fields.get(pair[0]) as string;
  const targetColumn = fields.get(pair[1]) as string;
  return {
    label: table.name,
    source: vertex.name,
    target: vertex.name,
    from: table.name,
    sourceColumn,
    targetColumn,
  };
}

function foreignKeyEdges(table: GraphColumnTable, tables: readonly GraphColumnTable[]): EdgeSpec[] {
  if (!hasId(table)) return [];
  const fields = fieldsOf(table);
  const id = fields.get("id") as string;
  const edges: EdgeSpec[] = [];
  for (const field of table.fields) {
    const match = field.toLowerCase().match(/^(.*)_id$/u);
    const stem = match?.[1];
    if (stem === undefined || stem === "" || stem === "source" || stem === "target" || stem === "from") continue;
    const target =
      tables.find((entry) => entry.name.toLowerCase() === stem && hasId(entry)) ??
      tables.find((entry) => entry.name.toLowerCase() === `${stem}s` && hasId(entry));
    if (target === undefined || target.name.toLowerCase() === table.name.toLowerCase()) continue;
    edges.push({
      label: `${table.name}_${field}`,
      source: table.name,
      target: target.name,
      from: table.name,
      sourceColumn: id,
      targetColumn: field,
    });
  }
  return edges;
}

/** Statements that create `saved`, or an empty list when the tables do not form a graph. */
export function propertyGraphSql(tables: readonly GraphColumnTable[]): string[] {
  const vertices = tables.filter(hasId);
  if (vertices.length === 0) return [];
  const edges: EdgeSpec[] = [];
  const seen = new Set<string>();
  for (const table of tables) {
    const direct = directEdge(table, vertices);
    const found = direct !== null ? [direct, ...foreignKeyEdges(table, tables)] : foreignKeyEdges(table, tables);
    for (const edge of found) {
      const key = edge.label.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push(edge);
    }
  }
  if (edges.length === 0) return [];
  const statements = ["CREATE SCHEMA graph"];
  const parts: string[] = [];
  for (const [index, edge] of edges.entries()) {
    const copy = `e${index}`;
    statements.push(
      `CREATE TABLE graph.${copy} AS SELECT ${quoteIdent(edge.sourceColumn)} AS src, ${quoteIdent(edge.targetColumn)} AS dst FROM ${quoteIdent("main")}.${quoteIdent(edge.from)}`,
    );
    parts.push(
      `graph.${copy} SOURCE KEY (src) REFERENCES ${quoteIdent(edge.source)} (${quoteIdent("id")}) DESTINATION KEY (dst) REFERENCES ${quoteIdent(edge.target)} (${quoteIdent("id")}) LABEL ${quoteIdent(edge.label)}`,
    );
  }
  const vertexList = vertices.map((vertex) => quoteIdent(vertex.name)).join(", ");
  statements.push(`CREATE PROPERTY GRAPH saved VERTEX TABLES (${vertexList}) EDGE TABLES (${parts.join(", ")})`);
  return statements;
}
