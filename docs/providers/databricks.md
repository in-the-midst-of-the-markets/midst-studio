# Databricks SQL Provider

Databricks SQL is its own connection type. Studio reaches a SQL warehouse through the statement execution API, `POST /api/2.0/sql/statements`, on the workspace host. The port is **443**. The access token is sent only to that host, as a bearer header. No Databricks client library is loaded.

The connection's catalog, when it names one, is sent as `catalog`. The schema, when it names one, is sent as `schema`, and the tree shows that schema only. Otherwise the tree lists schemas from `system.information_schema.schemata` for `current_catalog()`. Tables are `system.information_schema.tables` whose `table_type` is `MANAGED` or `EXTERNAL`. Columns are `system.information_schema.columns`. The `information_schema` schema stays hidden unless the connection names it. Views are not listed. Primary keys are not read.

A statement waits up to 30 seconds on the first response, then Studio polls the same statement. Inline chunks on the same host are read, at most eight. A result the API marks truncated, or hands out only as an external link, is refused: add a `LIMIT` and run it again. A statement that is still running after the wait is not cancelled. The session does not keep the statement id after it returns.

No live warehouse was available while this provider was written. The statements above are the ones the public SQL reference and the statement execution API name. Capabilities that were not exercised against a warehouse stay off: explain, inline row edit, transactions, maintenance, parameter binding and an agent language.

## SQL grammar

[`src/lib/db/providers/sql/databricks/sql-grammar.ts`](../../src/lib/db/providers/sql/databricks/sql-grammar.ts) declares `DATABRICKS_GRAMMAR`. `readsSqlText` is `true`. Redaction is `sql` with a backtick as its name quote.

Comments are `--` and block comments. `#` is code. `//` is not a comment. Names are backtick-quoted. A string is single-quoted, and a quote inside it is written twice. A backslash is left as data, because a live warehouse was not measured.

The editor completes Databricks SQL's own clauses and functions beside the shared SQL lists (the grammar's `completionWords`): `MERGE INTO`, `QUALIFY`, `OPTIMIZE`, `VACUUM`, `CLUSTER BY`, `DISTRIBUTE BY`, `TABLESAMPLE`, `PIVOT`, `UNPIVOT`, `LATERAL VIEW`, `CURRENT_CATALOG`, `CURRENT_SCHEMA`, `CURRENT_VERSION`, `DATEADD`, `DATEDIFF`, `EXPLODE`, `TRY_CAST` and `APPROX_COUNT_DISTINCT` among them. `LIMIT` and `MERGE INTO` are snippets. `MERGE INTO` is a table position.

Format uses sql-formatter's MySQL language (the grammar's `formatterLanguage`). That language quotes a name in backticks. A statement it cannot read is left as written.

## SQL writing

[`databricks/sql-writing.ts`](../../src/lib/db/providers/sql/databricks/sql-writing.ts) declares how a generated statement spells a literal, a name and a bind, and it is this engine's row of `SQL_WRITING`.

A literal is written by `literalStandard` and read back by `unquoteStandard`. A name is quoted by `identifierBacktickDoubled`. There is no placeholder: the session does not bind parameters, and `query()` refuses a parameter list.

`inlineEdit` uses `INSTANT_TYPE_NAMES`, `FLOAT64_TYPE_NAMES` and `EXACT_DECIMAL_TYPE_NAMES`. The provider does not offer inline row edit.

The module's `export` field writes a result export from `STANDARD_DDL_TYPES`, `NOTHING_STANDS_ALONE`, `NO_BARE_SPELLING`, `NULL_NON_FINITE` and `binaryStandardHex`.

## Connection string

[`connection-string.ts`](../../src/lib/db/providers/sql/databricks/connection-string.ts) shows no connection string scheme. There is no `readTls`. There is no `paste`. There is no seed load check.

## Execution UI

[`execution-ui.ts`](../../src/lib/db/providers/sql/databricks/execution-ui.ts) names `COMMIT` on the rolled-back notice. The consent card has no consent deadline.

## Object edit (#789)

Databricks SQL tables are not edited as source from the object tree. No kind declares `hasSource`. The absence is the one `tests/isolated/object-edit-declarations.test.ts` holds for this type-id.

## Migration DDL

[`DATABRICKS_MIGRATION_DDL`](../../src/lib/db/providers/sql/databricks/migration-ddl.ts) declines the whole diff. `refusal` is the one line the migration prints after its header, and `transactionWrapper` is `null`.

The refusal reason it prints, verbatim:

- "Databricks SQL table changes are not generated here; write the CREATE TABLE or ALTER TABLE by hand."

## Query

`query()` sends the statement it was given. A parameter list is refused. `SELECT` paging is `LIMIT n` and `LIMIT n OFFSET m`, applied by the shared limiter before the statement is sent.

The Explain button is off (`supportsExplain` is false). There is no maintenance operation: neither `ANALYZE` nor `VACUUM` is sent. There is no agent statement language.
