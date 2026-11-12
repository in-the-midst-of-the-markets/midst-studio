# CockroachDB Provider

CockroachDB is its own connection type. It speaks the PostgreSQL wire protocol on port 26257, and Studio reaches it with the `pg` driver. It is not a PostgreSQL connection. The `postgres` provider issues `SELECT pg_backend_pid()` whenever a run carries a query id, and it reads sizes from `pg_total_relation_size`. This provider sends the statement it was given.

The catalog is `information_schema.tables` and `information_schema.columns`. Schemas named `information_schema`, `pg_catalog`, `crdb_internal` or `pg_extension`, and any schema whose name begins with `pg_`, are hidden. Tables and views are listed. Sizes stay unmeasured: the overview does not call `pg_total_relation_size`, `pg_size_pretty` or `pg_postmaster_start_time`. The version string is `version()`.

Default port **26257**. The host is the cluster host. The user and the database name are required. A local cluster's usual user is `root` and its usual database is `defaultdb`. A live cluster was not probed for this connection; the statements below are the ones the provider sends. Measurements of CockroachDB CCL v26.2.6 and v26.3.2 through the `postgres` type stay in [postgres.md](./postgres.md).

The password is sent to the host the connection names, on that wire. Set the SSL mode to `require` for a cluster that demands TLS.

## SQL grammar

[`src/lib/db/providers/sql/cockroach/sql-grammar.ts`](../../src/lib/db/providers/sql/cockroach/sql-grammar.ts) declares `COCKROACH_GRAMMAR`. `readsSqlText` is `true`. Redaction is `sql` with `"` as its name quote.

Comments are `--` and `/* */`. Block comments are read flat. `#` is code. `//` is not a comment. Names are double-quoted.

The editor completes CockroachDB's own words beside the shared SQL lists (the grammar's `completionWords`): `INVERTED`, `STORING`, `FAMILY`, `INTERLEAVE`, `now` and `experimental_strftime` among them. `INVERTED` and `STORING` are column positions.

Format uses sql-formatter's MySQL language (the grammar's `formatterLanguage`). A statement that language cannot read is left as written.

## SQL writing

[`cockroach/sql-writing.ts`](../../src/lib/db/providers/sql/cockroach/sql-writing.ts) declares how a generated statement spells a literal, a name and a bind, and it is this engine's row of `SQL_WRITING`.

A literal is written by `literalStandard` and read back by `unquoteStandard`. A name is quoted by `identifierDoubleQuoted`. There is no placeholder: the wire session does not bind parameters, and `query()` refuses a parameter list.

`inlineEdit` uses `INSTANT_TYPE_NAMES`, `FLOAT64_TYPE_NAMES` and `EXACT_DECIMAL_TYPE_NAMES`. The provider does not offer inline row edit.

The module's `export` field writes a result export from `STANDARD_DDL_TYPES`, `NOTHING_STANDS_ALONE`, `NO_BARE_SPELLING`, `NULL_NON_FINITE` and `binaryStandardHex`.

## Connection string

[`connection-string.ts`](../../src/lib/db/providers/sql/cockroach/connection-string.ts) shows no connection string scheme. There is no `readTls`. There is no `paste`: a `postgresql://` string belongs to the PostgreSQL type. There is no seed load check.

## Execution UI

[`execution-ui.ts`](../../src/lib/db/providers/sql/cockroach/execution-ui.ts) names `COMMIT` on the rolled-back notice. The consent card has no consent deadline.

## Object edit (#789)

CockroachDB tables are not edited as source from the object tree. No kind declares `hasSource`. The absence is the one `tests/isolated/object-edit-declarations.test.ts` holds for this type-id.

## Migration DDL

[`COCKROACH_MIGRATION_DDL`](../../src/lib/db/providers/sql/cockroach/migration-ddl.ts) declines the whole diff. `refusal` is the one line the migration prints after its header, and `transactionWrapper` is `null`.

The refusal reason it prints, verbatim:

- "CockroachDB table changes are not generated here; write the CREATE TABLE or ALTER TABLE by hand."

## Query

`query()` ignores the query id. It does not call `pg_backend_pid()`. A parameter list is refused. `SELECT` paging is `LIMIT n` and `LIMIT n OFFSET m`, applied by the shared limiter before the statement is sent.

`EXPLAIN` can be typed. The Explain button is off (`supportsExplain` is false), because PostgreSQL's `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` is not the plan format this connection sends. There is no maintenance operation from Studio: it does not send `VACUUM`, `REINDEX` or a bare `ANALYZE`. `ANALYZE` that names one table is a statement the user writes.
