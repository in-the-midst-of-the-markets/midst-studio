# Meta Ads Provider

Meta Ads is its own connection type. Studio reaches one ad account over the Marketing API Graph API v27.0 (`https://graph.facebook.com/v27.0`). It is not a SQL server. The editor still runs SQL: one `SELECT` is one list of one standard resource, and the filter, the order and the page are applied to that answer. A write is refused before a request. The rows are not copied into another database. The connection is read-only. Reporting metrics are not columns, and `paging.next` is not followed.

The password is a Marketing API access token. It is sent only to `graph.facebook.com`, as an `Authorization: Bearer` header. Studio does not put it in the URL, does not exchange it and does not refresh it. An optional `Bearer ` prefix is removed. The database field is the ad account id. A pasted `act_` prefix is removed, and the request path is `act_<id>`. An empty host uses `graph.facebook.com`. Any other host is refused, and the refusal does not repeat the host or the token. The dialog has no TLS panel and no SSH tunnel. The user field is not used.

The object tree is one account and the standard resources this connection shows: `campaign`, `ad_set` and `ad`. One statement asks for 1000 rows. When the answer carries `paging.next`, the rest of the account is not requested.

## SQL grammar

[`src/lib/db/providers/sql/metaads/sql-grammar.ts`](../../src/lib/db/providers/sql/metaads/sql-grammar.ts) declares `METAADS_SQL_GRAMMAR`, whose `grammar` is `META_ADS_GRAMMAR`. `readsSqlText` is `true`. Redaction is `sql` with `"` as its name quote.

Comments are `--` and `/* */`. `#` is code. `//` is not a comment. Names are double-quoted. Format uses sql-formatter's MySQL language (the grammar's `formatterLanguage`).

The editor offers only the words this subset runs (`completionWords` with `lists: "only"`): `SELECT`, `FROM`, `WHERE`, `AND`, `ORDER BY`, `ASC`, `DESC`, `LIMIT`, `OFFSET`, `LIKE`, `IS NULL` and `IS NOT NULL`. It does not offer `INSERT`, `UPDATE`, `DELETE`, `JOIN`, `COUNT` or the shared function list. A field whose name contains a dot, such as `campaign.name`, is completed as that one word. The `SELECT` snippet is a statement this connection can run.

What the provider actually runs is the subset, and a statement outside it fails before a request:

- `SELECT` columns or `*` from one listed resource, such as `campaign`, `ad_set` or `ad`. A field is the name this connection lists, such as `campaign.status` or `ad.name`.
- `WHERE` comparisons (`=`, `!=`, `<>`, `<`, `>`, `<=`, `>=`), `LIKE`, `IS NULL` and `IS NOT NULL`. `AND` only. Text values are quoted (`campaign.status = 'ACTIVE'`). A number is unquoted. `LIKE` applies to a text field.
- `ORDER BY` one field. A null sorts last.
- `LIMIT` and `OFFSET`, capped at 1000 rows. The default limit is 100. The API is asked for one page of at most 1000, and Studio keeps the page locally. An `OFFSET` of 1000 or more returns no rows and does not call the API.

`COUNT(*)`, `OR`, a join, `IN`, `DISTINCT`, a second statement, and a parameter list are refused.

## SQL writing

[`metaads/sql-writing.ts`](../../src/lib/db/providers/sql/metaads/sql-writing.ts) declares how a generated statement spells a literal, a name and a bind, and it is this engine's row of `SQL_WRITING`.

A literal is written by `literalStandard` and read back by `unquoteStandard`. A name is quoted by `identifierDoubleQuoted`. There is no placeholder: the API does not bind parameters, and `query()` refuses a parameter list.

`inlineEdit` uses `INSTANT_TYPE_NAMES`, `FLOAT64_TYPE_NAMES` and `EXACT_DECIMAL_TYPE_NAMES`. The provider does not offer inline row edit.

The module's `export` field writes a result export from `STANDARD_DDL_TYPES`, `NOTHING_STANDS_ALONE`, `NO_BARE_SPELLING`, `NULL_NON_FINITE` and `binaryStandardHex`.

## Connection string

[`connection-string.ts`](../../src/lib/db/providers/sql/metaads/connection-string.ts) shows no connection string scheme. There is no `readTls`. There is no `paste`. There is no seed load check.

## Execution UI

[`execution-ui.ts`](../../src/lib/db/providers/sql/metaads/execution-ui.ts) names `COMMIT` on the rolled-back notice. The consent card has no consent deadline.

## Object edit (#789)

Meta Ads objects are not edited as source from the object tree. No kind declares `hasSource`. The absence is the one `tests/isolated/object-edit-declarations.test.ts` holds for this type-id. No kind declares `acceptsRowWrites` or `acceptsSourceEdits`. The connection is read-only.

## Migration DDL

[`METAADS_MIGRATION_DDL`](../../src/lib/db/providers/sql/metaads/migration-ddl.ts) declines the whole diff. `refusal` is the one line the migration prints after its header, and `transactionWrapper` is `null`.

The refusal reason it prints, verbatim:

- "Meta Ads object changes are not generated here; this connection is read-only."

## Query

A `SELECT` is `GET /v27.0/act_<account>/<edge>?fields=<comma-separated>&limit=1000`. `campaign` reads `/campaigns`, `ad_set` reads `/adsets` and `ad` reads `/ads`. `SELECT` of named columns returns those columns. `SELECT *` returns the columns this connection lists for that resource. An id is kept as text, because a Meta id can be longer than a JavaScript integer. `daily_budget` and `lifetime_budget` are the minor-unit amounts the API returns, kept as numbers. A nested value is JSON. A `LIMIT` above 1000 warns that the read is 1000. An `OFFSET` past 1000 returns no rows and a warning, and it does not call the API. An answer that carries an `error` object is a failed read. An answer that carries `paging.next` warns that the rest of the account was not read. Generate Query omits `WHERE 1=1` (`supportsConstantPredicate` is false). `EXPLAIN` is not offered (`supportsExplain` is false). There is no maintenance operation. There is no agent language pack: `AGENT_STATEMENT_LANGUAGE` is null for this type-id, and MCP stays closed.
