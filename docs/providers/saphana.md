# SAP HANA Provider

SAP HANA is its own connection type. Studio reaches it with the pure JavaScript `hdb` client (SAP node-hdb) on the indexserver port. Instance 00 listens on **30015**. HANA Cloud listens on **443**, and that port is opened with TLS. The native `@sap/hana-client` is not loaded.

A current schema, when the connection names one, is applied with `SET SCHEMA` after `SELECT 1 FROM DUMMY`. The catalog is `SYS.SCHEMAS`, `SYS.TABLES` (`TABLE_TYPE` `ROW` or `COLUMN`) and `SYS.TABLE_COLUMNS`. Primary-key columns are read from `SYS.INDEX_COLUMNS` where `CONSTRAINT` is `PRIMARY KEY`. `SYS`, `SYSTEM` and schemas whose names start with `_SYS` stay hidden unless the connection names one of them. The version string is `SELECT VERSION FROM SYS.M_DATABASE`.

No live HANA server was available while this provider was written. The statements above are the ones the public SQL reference names. Capabilities that were not exercised against a server stay off: explain, inline row edit, transactions, maintenance, parameter binding and an agent language.

## SQL grammar

[`src/lib/db/providers/sql/saphana/sql-grammar.ts`](../../src/lib/db/providers/sql/saphana/sql-grammar.ts) declares `SAPHANA_GRAMMAR`. `readsSqlText` is `true`. Redaction is `sql` with `"` as its name quote.

Comments are `--` and `/* */`. `#` is code. `//` is not a comment. Names are double-quoted. An unquoted name is uppercased by the server.

The editor completes HANA's own clauses and functions beside the shared SQL lists (the grammar's `completionWords`): `TOP`, `UPSERT`, `MERGE INTO`, `WITH HINT`, `SERIES`, `ADD_DAYS`, `DAYS_BETWEEN`, `CURRENT_UTCTIMESTAMP`, `IFNULL`, `TO_TIMESTAMP` and `STRING_AGG` among them. `FROM DUMMY` and `LIMIT` are snippets. `MERGE INTO` is a table position.

Format uses sql-formatter's Snowflake language (the grammar's `formatterLanguage`). That language leaves a double-quoted name quoted. A statement it cannot read is left as written.

## SQL writing

[`saphana/sql-writing.ts`](../../src/lib/db/providers/sql/saphana/sql-writing.ts) declares how a generated statement spells a literal, a name and a bind, and it is this engine's row of `SQL_WRITING`.

A literal is written by `literalStandard` and read back by `unquoteStandard`. A name is quoted by `identifierDoubleQuoted`. There is no placeholder: the session does not bind parameters, and `query()` refuses a parameter list.

`inlineEdit` uses `INSTANT_TYPE_NAMES`, `FLOAT64_TYPE_NAMES` and `EXACT_DECIMAL_TYPE_NAMES`. The provider does not offer inline row edit.

The module's `export` field writes a result export from `STANDARD_DDL_TYPES`, `NOTHING_STANDS_ALONE`, `NO_BARE_SPELLING`, `NULL_NON_FINITE` and `binaryStandardHex`.

## Connection string

[`connection-string.ts`](../../src/lib/db/providers/sql/saphana/connection-string.ts) shows no connection string scheme. There is no `readTls`. There is no `paste`. There is no seed load check.

## Execution UI

[`execution-ui.ts`](../../src/lib/db/providers/sql/saphana/execution-ui.ts) names `COMMIT` on the rolled-back notice. The consent card has no consent deadline.

## Object edit (#789)

SAP HANA tables are not edited as source from the object tree. No kind declares `hasSource`. The absence is the one `tests/isolated/object-edit-declarations.test.ts` holds for this type-id.

## Migration DDL

[`SAPHANA_MIGRATION_DDL`](../../src/lib/db/providers/sql/saphana/migration-ddl.ts) declines the whole diff. `refusal` is the one line the migration prints after its header, and `transactionWrapper` is `null`.

The refusal reason it prints, verbatim:

- "SAP HANA table changes are not generated here; write the CREATE TABLE or ALTER TABLE by hand."

## Query

`query()` sends the statement it was given. A parameter list is refused. `SELECT` paging is `LIMIT n` and `LIMIT n OFFSET m`, applied by the shared limiter before the statement is sent.

The Explain button is off (`supportsExplain` is false). There is no maintenance operation: neither `ANALYZE` nor `VACUUM` is sent. There is no agent statement language.
