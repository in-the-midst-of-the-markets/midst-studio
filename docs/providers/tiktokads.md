# TikTok Ads Provider

TikTok Ads is its own connection type. Studio reaches one advertiser over the Marketing API v1.3 (`https://business-api.tiktok.com/open_api/v1.3`). It is not a SQL server. The editor still runs SQL: one `SELECT` is one list of one standard resource, and the filter, the order and the page are applied to that answer. A write is refused before a request. The rows are not copied into another database. The connection is read-only. Reporting metrics are not columns, and the next page is not requested.

The password is a Marketing API access token. It is sent only to `business-api.tiktok.com`, as the `Access-Token` header. Studio does not put it in the URL, does not exchange it and does not refresh it. An optional `Bearer ` prefix is removed. The database field is the advertiser id, sent as `advertiser_id`. An empty host uses `business-api.tiktok.com`. Any other host is refused, and the refusal does not repeat the host or the token. The dialog has no TLS panel and no SSH tunnel. The user field is not used.

The object tree is one advertiser and the standard resources this connection shows: `campaign`, `ad_group` and `ad`. One statement stops at 1000 rows, which is the largest page the API returns.

## SQL grammar

[`src/lib/db/providers/sql/tiktokads/sql-grammar.ts`](../../src/lib/db/providers/sql/tiktokads/sql-grammar.ts) declares `TIKTOKADS_SQL_GRAMMAR`. `readsSqlText` is `true`. Redaction is `sql` with `"` as its name quote.

Comments are `--` and `/* */`. `#` is code. `//` is not a comment. Names are double-quoted. Format uses sql-formatter's MySQL language (the grammar's `formatterLanguage`).

The editor offers only the words this subset runs (`completionWords` with `lists: "only"`): `SELECT`, `FROM`, `WHERE`, `AND`, `ORDER BY`, `ASC`, `DESC`, `LIMIT`, `OFFSET`, `LIKE`, `IS NULL` and `IS NOT NULL`. It does not offer `INSERT`, `UPDATE`, `DELETE`, `JOIN`, `COUNT` or the shared function list. A field whose name contains a dot, such as `campaign.name`, is completed as that one word. The `SELECT` snippet is a statement this connection can run.

What the provider actually runs is the subset, and a statement outside it fails before a request:

- `SELECT` columns or `*` from one listed resource, such as `campaign`, `ad_group` or `ad`. A field is the name this connection lists, such as `campaign.operation_status` or `ad.name`.
- `WHERE` comparisons (`=`, `!=`, `<>`, `<`, `>`, `<=`, `>=`), `LIKE`, `IS NULL` and `IS NOT NULL`. `AND` only. Text values are quoted (`campaign.operation_status = 'ENABLE'`). A number is unquoted. `LIKE` applies to a text field.
- `ORDER BY` one field. A null sorts last.
- `LIMIT` and `OFFSET`, capped at 1000 rows. The default limit is 100. The API returns one page of at most 1000, and Studio keeps the page locally. An `OFFSET` of 1000 or more returns no rows and does not call the API.

`COUNT(*)`, `OR`, a join, `IN`, `DISTINCT`, a second statement, and a parameter list are refused.

## SQL writing

[`tiktokads/sql-writing.ts`](../../src/lib/db/providers/sql/tiktokads/sql-writing.ts) declares how a generated statement spells a literal, a name and a bind, and it is this engine's row of `SQL_WRITING`.

A literal is written by `literalStandard` and read back by `unquoteStandard`. A name is quoted by `identifierDoubleQuoted`. There is no placeholder: the API does not bind parameters, and `query()` refuses a parameter list.

`inlineEdit` uses `INSTANT_TYPE_NAMES`, `FLOAT64_TYPE_NAMES` and `EXACT_DECIMAL_TYPE_NAMES`. The provider does not offer inline row edit.

The module's `export` field writes a result export from `STANDARD_DDL_TYPES`, `NOTHING_STANDS_ALONE`, `NO_BARE_SPELLING`, `NULL_NON_FINITE` and `binaryStandardHex`.

## Connection string

[`connection-string.ts`](../../src/lib/db/providers/sql/tiktokads/connection-string.ts) shows no connection string scheme. There is no `readTls`. There is no `paste`. There is no seed load check.

## Execution UI

[`execution-ui.ts`](../../src/lib/db/providers/sql/tiktokads/execution-ui.ts) names `COMMIT` on the rolled-back notice. The consent card has no consent deadline.

## Object edit (#789)

TikTok Ads objects are not edited as source from the object tree. No kind declares `hasSource`. The absence is the one `tests/isolated/object-edit-declarations.test.ts` holds for this type-id. No kind declares `acceptsRowWrites` or `acceptsSourceEdits`. The connection is read-only.

## Migration DDL

[`TIKTOKADS_MIGRATION_DDL`](../../src/lib/db/providers/sql/tiktokads/migration-ddl.ts) declines the whole diff. `refusal` is the one line the migration prints after its header, and `transactionWrapper` is `null`.

The refusal reason it prints, verbatim:

- "TikTok Ads object changes are not generated here; this connection is read-only."

## Query

A `SELECT` is `GET /open_api/v1.3/<resource>/get/?advertiser_id=<id>&page=1&page_size=1000&fields=<json>`. `campaign` reads `/open_api/v1.3/campaign/get/`, `ad_group` reads `/open_api/v1.3/adgroup/get/` and `ad` reads `/open_api/v1.3/ad/get/`. `SELECT` of named columns returns those columns. `SELECT *` returns the columns this connection lists for that resource. An id is kept as text, because a TikTok id can be longer than a JavaScript integer, and a nested value is JSON. A `LIMIT` above 1000 warns that the read is 1000. An `OFFSET` past 1000 returns no rows and a warning, and it does not call the API. An answer whose `code` is not 0 is a failed read. Generate Query omits `WHERE 1=1` (`supportsConstantPredicate` is false). `EXPLAIN` is not offered (`supportsExplain` is false). There is no maintenance operation. There is no agent language pack: `AGENT_STATEMENT_LANGUAGE` is null for this type-id, and MCP stays closed.
