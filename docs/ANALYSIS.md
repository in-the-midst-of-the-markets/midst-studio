# Analysis features

The IDE chat includes this catalog when the connected engine is DuckDB. Cross_DB_Joins uses that engine, so a question about joined saved queries sees the same text. The sentences live once, in `src/lib/analysis/features.ts`, and `analysisFeaturesDocument()` returns them as data.

MCP does not serve this catalog. A later resource can return that object unchanged. It is not a tool, and the chat still has to write one read-only statement.

## saved-join

**Join saved queries from different databases**

Use when the question needs rows from more than one connection.

```sql
SELECT orders.name, people.email FROM orders JOIN people ON orders.id = people.id
```

On Cross_DB_Joins each saved-query ID is a table. One DuckDB SELECT reads at most 8 saved queries. The statement cannot read a file or the server's settings.

## vector-rank

**Rank rows by a vector**

Use when the question asks which rows are closest to a vector, an embedding, or an example row.

```sql
SELECT id FROM docs ORDER BY array_cosine_distance(embedding, [1, 0]::FLOAT[2]) LIMIT 5
```

On a saved join a numeric array column of one length is stored as FLOAT[n]. array_distance and array_negative_inner_product rank by the other two distances. The join builds a cosine HNSW index when the vss extension loaded. A DuckDB file can use the same functions when the column is already FLOAT[n].

## vector-join

**Join two saved queries by vector similarity**

Use when the question asks to match each row of one saved query to the nearest rows of another.

```sql
SELECT * FROM vss_join(needle, haystack, embedding, embedding, 3)
```

vss_match(haystack, embedding, embedding, 3) searches one saved query. The table arguments are saved-query IDs. Both need the vss extension, which a saved join loads and a DuckDB file does not.

## graph-walk

**Walk edges with a recursive query**

Use when the question asks who is reachable, what the path is, or how many hops connect two rows.

```sql
WITH RECURSIVE walk(id, depth) AS (SELECT dst, 1 FROM knows WHERE src = 1 UNION ALL SELECT k.dst, walk.depth + 1 FROM walk JOIN knows k ON k.src = walk.id WHERE walk.depth < 4) SELECT * FROM walk
```

This is ordinary DuckDB SQL on a saved join or a DuckDB file. Stop the walk with a depth test.

## graph-rank

**Rank, cluster, or split a property graph**

Use when the question asks for importance, communities, or connected groups across saved queries.

```sql
SELECT * FROM pagerank('saved', 'person', 'knows')
```

weakly_connected_component('saved', vertex, edge) and local_clustering_coefficient('saved', vertex, edge) read the same graph. A table with an id column is a vertex. A table with src and dst, source and target, source_id and target_id, or from_id and to_id is an edge when one other vertex exists. A column named other_id points at the saved query other, or at its plural. The graph is named saved. MATCH and GRAPH_TABLE are not accepted. These functions run on Cross_DB_Joins, which loads duckpgq, and not on a DuckDB file.
