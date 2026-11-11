/**
 * The bulk object reads SQLite and libSQL both run.
 *
 * libSQL is SQLite over HTTP, so the pragma text is one copy. The SQLite provider
 * issues the five statements one after another on a file handle. libSQL sends the
 * same five in one batch.
 *
 * `ORDER BY t.name` decides which objects a bounded read keeps. `pragma_table_list`
 * has no useful order of its own, measured on bun:sqlite and on sqld 0.24.33. That
 * sort is the engine's byte order, which is not the order a JavaScript sort of the
 * same names produces.
 *
 * `LIMIT ?` is bound and sits inside the CTE. Both file drivers and sqld accept
 * that. Membership comes from the target statement, not from the column read: an
 * object whose every column is hidden would otherwise disappear from the batch.
 */

export interface SqliteBulkDetailStatements {
  readonly target: string;
  readonly columns: string;
  readonly indexes: string;
  readonly indexColumns: string;
  readonly foreignKeys: string;
  /** How many trailing schema binds each statement above takes, in that order. */
  readonly schemaBinds: readonly [number, number, number, number, number];
}

function describedCte(types: readonly string[], bounded: boolean): string {
  return `WITH described AS (
        SELECT t.name AS object_name
          FROM pragma_table_list AS t
         WHERE t.schema = ?
           AND t.type IN (${types.map((type) => `'${type}'`).join(", ")})
           AND t.name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
         ORDER BY t.name${bounded ? "\n         LIMIT ?" : ""}
      )`;
}

/** The five statements of one bulk read of `types`, with or without the row bound. */
export function sqliteBulkDetailStatements(types: readonly string[], bounded: boolean): SqliteBulkDetailStatements {
  const described = describedCte(types, bounded);
  return {
    target: `${described}
      SELECT d.object_name AS object_name FROM described AS d`,
    columns: `${described}
      SELECT d.object_name AS object_name, x.name AS name, x.type AS type,
             x."notnull" AS "notnull", x.dflt_value AS dflt_value, x.pk AS pk
        FROM described AS d
        JOIN pragma_table_xinfo(d.object_name, ?) AS x
       WHERE x.hidden <> 1
       ORDER BY d.object_name, x.cid`,
    indexes: `${described}
      SELECT d.object_name AS object_name, i.name AS name, i."unique" AS "unique"
        FROM described AS d
        JOIN pragma_index_list(d.object_name, ?) AS i
       WHERE i.name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
       ORDER BY d.object_name, i.name`,
    indexColumns: `${described}, listed AS (
        SELECT d.object_name AS object_name, i.name AS index_name
          FROM described AS d
          JOIN pragma_index_list(d.object_name, ?) AS i
         WHERE i.name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
      )
      SELECT l.object_name AS object_name, l.index_name AS index_name, c.name AS name
        FROM listed AS l
        JOIN pragma_index_info(l.index_name, ?) AS c
       ORDER BY l.object_name, l.index_name, c.seqno`,
    foreignKeys: `${described}
      SELECT d.object_name AS object_name, f.id AS id, f.seq AS seq, f."table" AS "table",
             f."from" AS "from", f."to" AS "to",
             (SELECT p.name FROM pragma_table_info(f."table", ?) AS p WHERE p.pk = f.seq + 1) AS parent_key
        FROM described AS d
        JOIN pragma_foreign_key_list(d.object_name, ?) AS f
       ORDER BY d.object_name, f.id, f.seq`,
    schemaBinds: [0, 1, 1, 2, 2],
  };
}
