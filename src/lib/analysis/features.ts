/**
 * The analysis features a model may use when it writes a DuckDB statement.
 *
 * The IDE prompts include `ANALYSIS_FEATURE_GUIDE` for that engine. `analysisFeaturesDocument`
 * is the same list as data. MCP does not serve it yet; a later resource can return the object
 * unchanged, with no second copy of the sentences.
 */

export interface AnalysisFeature {
  readonly id: string;
  readonly title: string;
  readonly useWhen: string;
  readonly statement: string;
  readonly limit: string;
}

export const ANALYSIS_FEATURES_TITLE = "Analysis features";

/**
 * What a saved join can do beyond a plain SELECT.
 *
 * Each statement is one the saved-join checker accepts. A DuckDB file can rank an existing
 * FLOAT array and walk edges with a recursive query. The vector join and the property-graph
 * functions run on Cross_DB_Joins, after that handle loads vss and duckpgq.
 */
export const ANALYSIS_FEATURES: readonly AnalysisFeature[] = [
  {
    id: "saved-join",
    title: "Join saved queries from different databases",
    useWhen: "the question needs rows from more than one connection.",
    statement: "SELECT orders.name, people.email FROM orders JOIN people ON orders.id = people.id",
    limit:
      "On Cross_DB_Joins each saved-query ID is a table. One DuckDB SELECT reads at most 8 saved queries. The statement cannot read a file or the server's settings.",
  },
  {
    id: "vector-rank",
    title: "Rank rows by a vector",
    useWhen: "the question asks which rows are closest to a vector, an embedding, or an example row.",
    statement: "SELECT id FROM docs ORDER BY array_cosine_distance(embedding, [1, 0]::FLOAT[2]) LIMIT 5",
    limit:
      "On a saved join a numeric array column of one length is stored as FLOAT[n]. array_distance and array_negative_inner_product rank by the other two distances. The join builds a cosine HNSW index when the vss extension loaded. A DuckDB file can use the same functions when the column is already FLOAT[n].",
  },
  {
    id: "vector-join",
    title: "Join two saved queries by vector similarity",
    useWhen: "the question asks to match each row of one saved query to the nearest rows of another.",
    statement: "SELECT * FROM vss_join(needle, haystack, embedding, embedding, 3)",
    limit:
      "vss_match(haystack, embedding, embedding, 3) searches one saved query. The table arguments are saved-query IDs. Both need the vss extension, which a saved join loads and a DuckDB file does not.",
  },
  {
    id: "graph-walk",
    title: "Walk edges with a recursive query",
    useWhen: "the question asks who is reachable, what the path is, or how many hops connect two rows.",
    statement:
      "WITH RECURSIVE walk(id, depth) AS (SELECT dst, 1 FROM knows WHERE src = 1 UNION ALL SELECT k.dst, walk.depth + 1 FROM walk JOIN knows k ON k.src = walk.id WHERE walk.depth < 4) SELECT * FROM walk",
    limit: "This is ordinary DuckDB SQL on a saved join or a DuckDB file. Stop the walk with a depth test.",
  },
  {
    id: "graph-rank",
    title: "Rank, cluster, or split a property graph",
    useWhen: "the question asks for importance, communities, or connected groups across saved queries.",
    statement: "SELECT * FROM pagerank('saved', 'person', 'knows')",
    limit:
      "weakly_connected_component('saved', vertex, edge) and local_clustering_coefficient('saved', vertex, edge) read the same graph. A table with an id column is a vertex. A table with src and dst, source and target, source_id and target_id, or from_id and to_id is an edge when one other vertex exists. A column named other_id points at the saved query other, or at its plural. The graph is named saved. MATCH and GRAPH_TABLE are not accepted. These functions run on Cross_DB_Joins, which loads duckpgq, and not on a DuckDB file.",
  },
];

export interface AnalysisFeaturesDocument {
  readonly title: string;
  readonly features: readonly AnalysisFeature[];
}

/** The object a later MCP resource can return. It is not registered as a tool. */
export function analysisFeaturesDocument(): AnalysisFeaturesDocument {
  return { title: ANALYSIS_FEATURES_TITLE, features: ANALYSIS_FEATURES };
}

/** The block the IDE prompt appends. Empty when there are no features to offer. */
export function renderAnalysisGuide(features: readonly AnalysisFeature[]): string {
  if (features.length === 0) return "";
  const lines = features.map(
    (feature) =>
      `${feature.id} — ${feature.title}. Use when ${feature.useWhen} Statement: \`${feature.statement}\`. ${feature.limit}`,
  );
  return `Analysis features you can use on this engine. Pick one when it fits the question, and keep the statement inside the engine rule.\n${lines.join("\n")}`;
}

export const ANALYSIS_FEATURE_GUIDE = renderAnalysisGuide(ANALYSIS_FEATURES);
