# QuestDB Provider

QuestDB is its own connection type. It speaks the PostgreSQL wire protocol on port 8812, and Studio reaches it with the `pg` driver. It is not a PostgreSQL connection. The `postgres` provider issues `SELECT pg_backend_pid()` whenever a run carries a query id, and QuestDB has no such function, so pressing Run on a PostgreSQL connection fails even when the same statement succeeds on its own. This provider sends the statement it was given.

The catalog is `tables()` and `table_columns('name')`. `telemetry` and `telemetry_config` are hidden. Monitoring that would need `pg_stat_*` is left empty. The version string is `build()`, not `version()`, which reports a PostgreSQL-shaped string.

Default port **8812**, default user `admin`, default database `qdb`. The HTTP console on port 9000 is not this connection.

## SQL grammar

[`src/lib/db/providers/sql/questdb/sql-grammar.ts`](../../src/lib/db/providers/sql/questdb/sql-grammar.ts) declares `QUESTDB_GRAMMAR`. `readsSqlText` is `true`. Redaction is `sql` with `"` as its name quote.

Comments are `--` and `/* */`. `#` is code. `//` is not a comment. Names are double-quoted.

## SQL writing

[`questdb/sql-writing.ts`](../../src/lib/db/providers/sql/questdb/sql-writing.ts) declares how a generated statement spells a literal, a name and a bind, and it is this engine's row of `SQL_WRITING`.

A literal is written by `literalStandard` and read back by `unquoteStandard`. A name is quoted by `identifierDoubleQuoted`. There is no placeholder: the wire session does not bind parameters, and `query()` refuses a parameter list.

`inlineEdit` uses `INSTANT_TYPE_NAMES`, `FLOAT64_TYPE_NAMES` and `EXACT_DECIMAL_TYPE_NAMES`. The provider does not offer inline row edit.

The module's `export` field writes a result export from `STANDARD_DDL_TYPES`, `NOTHING_STANDS_ALONE`, `NO_BARE_SPELLING`, `NULL_NON_FINITE` and `binaryStandardHex`.

## Connection string

[`connection-string.ts`](../../src/lib/db/providers/sql/questdb/connection-string.ts) shows no connection string scheme. There is no `readTls`. There is no `paste`: a `postgresql://` string belongs to the PostgreSQL type. There is no seed load check.

## Execution UI

[`execution-ui.ts`](../../src/lib/db/providers/sql/questdb/execution-ui.ts) names `COMMIT` on the rolled-back notice. The consent card has no consent deadline.

## Object edit (#789)

QuestDB tables are not edited as source from the object tree. No kind declares `hasSource`. The absence is the one `tests/isolated/object-edit-declarations.test.ts` holds for this type-id.

## Migration DDL

[`QUESTDB_MIGRATION_DDL`](../../src/lib/db/providers/sql/questdb/migration-ddl.ts) declines the whole diff. `refusal` is the one line the migration prints after its header, and `transactionWrapper` is `null`.

The refusal reason it prints, verbatim:

- "QuestDB table changes are not generated here; write the CREATE TABLE or ALTER TABLE by hand."

## Query

`query()` ignores the query id. It does not call `pg_backend_pid()`. A parameter list is refused. `SELECT` paging is `LIMIT n` and `LIMIT n OFFSET m`, applied by the shared limiter before the statement is sent.

`EXPLAIN` can be typed. The Explain button is off (`supportsExplain` is false), because PostgreSQL's `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` is not QuestDB's plan format. There is no maintenance operation: neither `ANALYZE` nor `VACUUM` is sent.
