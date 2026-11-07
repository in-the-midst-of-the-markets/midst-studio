# Microsoft Clarity Provider

Microsoft Clarity is its own connection type. Studio reaches a project over the Data Export API (`https://www.clarity.ms`). It is not a SQL server, and the rows are not copied into another database. The editor still runs SQL: one `SELECT` or `COUNT(*)` is one export. A write is refused before a request. The connection is read-only.

The connection is a Data Export token in the password field. The API host is `www.clarity.ms`. The token is sent only there, over TLS, on the shared HTTP transport. That path does not use global fetch, so a proxy setting cannot carry the token. Any other host is refused, and the refusal does not repeat the host or the token. A redirect is not followed. The dialog has no TLS panel and no SSH tunnel.

The object tree is one project and one table, `insights`. A project allows about 10 exports a day, and connecting spends one of them. Each query spends another. The export is the last 1, 2, or 3 days as one total, not a row per day, and it breaks down by at most three dimensions. The API returns at most 1000 rows and has no next page.

## SQL grammar

[`src/lib/db/providers/sql/clarity/sql-grammar.ts`](../../src/lib/db/providers/sql/clarity/sql-grammar.ts) declares `CLARITY_GRAMMAR`. `readsSqlText` is `true`. Redaction is `sql` with `"` as its name quote.

Comments are `--` and `/* */`. `#` is code. `//` is not a comment. Names are double-quoted. Format uses sql-formatter's MySQL language (the grammar's `formatterLanguage`).

The editor offers only the words this subset runs (`completionWords` with `lists: "only"`): `SELECT`, `FROM`, `WHERE`, `AND`, `ORDER BY`, `ASC`, `DESC`, `LIMIT`, `OFFSET` and `COUNT`. It does not offer `INSERT`, `UPDATE`, `DELETE`, `JOIN` or the shared function list. `SELECT` and `COUNT` are snippets, and each one is a statement this connection can run. Generate Query names the columns when there are at most eight, and writes `SELECT *` under a comment when the table has more fields than that.

What the provider actually runs is the subset, and a statement outside it fails before a request:

- `SELECT` columns or `*` from `insights`. `WHERE days = 1`, `2`, or `3` chooses the window (the default is 1). Other equalities are filtered after the export. `AND` only.
- A dimension in the select list or in `WHERE` is sent as `dimension1` through `dimension3`, at most three. The dimensions are Browser, Device, Country/Region, OS, Source, Medium, Campaign, Channel and URL. `Country/Region` is a quoted name because of the slash.
- `ORDER BY` one column, `LIMIT` and `OFFSET` apply to the rows already returned.
- `COUNT(*)` counts those rows. The API has no count of its own.

`OR`, a join, a second statement, and a parameter list are refused. `SELECT *` asks for no breakdown, and the columns are whatever the export returned.

## SQL writing

[`clarity/sql-writing.ts`](../../src/lib/db/providers/sql/clarity/sql-writing.ts) declares how a generated statement spells a literal, a name and a bind, and it is this engine's row of `SQL_WRITING`.

A literal is written by `literalStandard` and read back by `unquoteStandard`. A name is quoted by `identifierDoubleQuoted`. There is no placeholder: the API does not bind parameters, and `query()` refuses a parameter list.

`inlineEdit` uses `INSTANT_TYPE_NAMES`, `FLOAT64_TYPE_NAMES` and `EXACT_DECIMAL_TYPE_NAMES`. The provider does not offer inline row edit.

The module's `export` field writes a result export from `STANDARD_DDL_TYPES`, `NOTHING_STANDS_ALONE`, `NO_BARE_SPELLING`, `NULL_NON_FINITE` and `binaryStandardHex`.

## Connection string

[`connection-string.ts`](../../src/lib/db/providers/sql/clarity/connection-string.ts) shows no connection string scheme. There is no `readTls`. There is no `paste`. There is no seed load check.

## Execution UI

[`execution-ui.ts`](../../src/lib/db/providers/sql/clarity/execution-ui.ts) names `COMMIT` on the rolled-back notice. The consent card has no consent deadline.

## Object edit (#789)

Clarity objects are not edited as source from the object tree. No kind declares `hasSource`. The absence is the one `tests/isolated/object-edit-declarations.test.ts` holds for this type-id. No kind declares `acceptsRowWrites` or `acceptsSourceEdits`. The connection is read-only.

## Migration DDL

[`CLARITY_MIGRATION_DDL`](../../src/lib/db/providers/sql/clarity/migration-ddl.ts) declines the whole diff. `refusal` is the one line the migration prints after its header, and `transactionWrapper` is `null`.

The refusal reason it prints, verbatim:

- "Clarity object changes are not generated here; this connection is read-only."

## Query

The export is `GET /export-data/api/v1/project-live-insights` with `numOfDays` and up to three dimensions. Filter, sort, limit and offset happen after that one response. A result warns that the project allows 10 exports a day. A full page of 1000 rows warns that there is no next page.

Generate Query omits `WHERE 1=1` (`supportsConstantPredicate` is false). `EXPLAIN` is not offered (`supportsExplain` is false). There is no maintenance operation. There is no agent language pack: `AGENT_STATEMENT_LANGUAGE` is null for this type-id, and MCP stays closed.
