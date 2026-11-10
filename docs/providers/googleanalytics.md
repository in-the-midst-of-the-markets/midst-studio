# Google Analytics Provider

Google Analytics is its own connection type. Studio reaches a GA4 property over the Data API (`https://analyticsdata.googleapis.com`). Universal Analytics is not queried. It is not a SQL server, and the rows are not copied into another database. The editor still runs SQL: one `SELECT` is one `runReport`. A write is refused before a request. The connection is read-only.

The password is either an access token or a service-account key JSON. An access token is sent only to `analyticsdata.googleapis.com`. A service-account key is exchanged only at `oauth2.googleapis.com`, and the private key is not sent to the Data API. Both calls use the shared HTTP transport, so a proxy setting cannot carry the credential. A redirect is not followed. The property id is the numeric id in the database field. The dialog has no TLS panel and no SSH tunnel.

The object tree is one property and one table, `report`. Dimensions and metrics come from the property's metadata. `SELECT *` uses a short default (`date`, `country`, `activeUsers`, `sessions`, or the first names the property has) rather than the whole catalog.

## SQL grammar

[`src/lib/db/providers/sql/googleanalytics/sql-grammar.ts`](../../src/lib/db/providers/sql/googleanalytics/sql-grammar.ts) declares `GOOGLEANALYTICS_GRAMMAR`. `readsSqlText` is `true`. Redaction is `sql` with `"` as its name quote.

Comments are `--` and `/* */`. `#` is code. `//` is not a comment. Names are double-quoted. Format uses sql-formatter's MySQL language (the grammar's `formatterLanguage`).

The editor offers only the words this subset runs (`completionWords` with `lists: "only"`): `SELECT`, `FROM`, `WHERE`, `AND`, `ORDER BY`, `ASC`, `DESC`, `LIMIT` and `OFFSET`. It does not offer `INSERT`, `UPDATE`, `DELETE`, `JOIN`, `COUNT` or the shared function list. Inside `WHERE` it also offers the dates the report accepts, quoted so the statement can run: `'today'`, `'yesterday'`, `'7daysAgo'`, `'30daysAgo'` and `'90daysAgo'`. The `SELECT` snippet is a statement this connection can run. Generate Query names the columns when there are at most eight.

What the provider actually runs is the subset, and a statement outside it fails before a request:

- `SELECT` dimensions and metrics, or `*`, from `report`. At most 9 dimensions and 10 metrics. At least one metric.
- `WHERE startDate = '...'` and `endDate = '...'`. A date is `today`, `yesterday`, `NdaysAgo`, or `YYYY-MM-DD`. The default window is `7daysAgo` through `yesterday`.
- Other equalities are a dimension or metric filter, combined with `AND`.
- `ORDER BY` one selected column, `LIMIT` and `OFFSET`. The API returns at most 10000 rows.

`COUNT(*)`, `OR`, a join, a second statement, and a parameter list are refused. A name that is not in the property's metadata is refused before the request.

## SQL writing

[`googleanalytics/sql-writing.ts`](../../src/lib/db/providers/sql/googleanalytics/sql-writing.ts) declares how a generated statement spells a literal, a name and a bind, and it is this engine's row of `SQL_WRITING`.

A literal is written by `literalStandard` and read back by `unquoteStandard`. A name is quoted by `identifierDoubleQuoted`. There is no placeholder: the API does not bind parameters, and `query()` refuses a parameter list.

`inlineEdit` uses `INSTANT_TYPE_NAMES`, `FLOAT64_TYPE_NAMES` and `EXACT_DECIMAL_TYPE_NAMES`. The provider does not offer inline row edit.

The module's `export` field writes a result export from `STANDARD_DDL_TYPES`, `NOTHING_STANDS_ALONE`, `NO_BARE_SPELLING`, `NULL_NON_FINITE` and `binaryStandardHex`.

## Connection string

[`connection-string.ts`](../../src/lib/db/providers/sql/googleanalytics/connection-string.ts) shows no connection string scheme. There is no `readTls`. There is no `paste`. There is no seed load check.

## Execution UI

[`execution-ui.ts`](../../src/lib/db/providers/sql/googleanalytics/execution-ui.ts) names `COMMIT` on the rolled-back notice. The consent card has no consent deadline.

## Object edit (#789)

Google Analytics objects are not edited as source from the object tree. No kind declares `hasSource`. The absence is the one `tests/isolated/object-edit-declarations.test.ts` holds for this type-id. No kind declares `acceptsRowWrites` or `acceptsSourceEdits`. The connection is read-only.

## Migration DDL

[`GOOGLEANALYTICS_MIGRATION_DDL`](../../src/lib/db/providers/sql/googleanalytics/migration-ddl.ts) declines the whole diff. `refusal` is the one line the migration prints after its header, and `transactionWrapper` is `null`.

The refusal reason it prints, verbatim:

- "Google Analytics object changes are not generated here; this connection is read-only."

## Query

Metadata is `GET /v1beta/properties/{propertyId}/metadata`. A report is `POST /v1beta/properties/{propertyId}:runReport`. The scope a service account needs is `https://www.googleapis.com/auth/analytics.readonly`. Studio does not read `GOOGLE_APPLICATION_CREDENTIALS`, a metadata server, or a refresh token.

Generate Query omits `WHERE 1=1` (`supportsConstantPredicate` is false). `EXPLAIN` is not offered (`supportsExplain` is false). There is no maintenance operation. There is no agent language pack: `AGENT_STATEMENT_LANGUAGE` is null for this type-id, and MCP stays closed.
