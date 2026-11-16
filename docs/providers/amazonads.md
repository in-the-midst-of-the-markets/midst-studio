# Amazon Ads Provider

Amazon Ads is its own connection type. Studio reaches one advertising profile over the Amazon Advertising API (`https://advertising-api.amazon.com`, `https://advertising-api-eu.amazon.com`, or `https://advertising-api-fe.amazon.com`). It is not Amazon Business, it is not Selling Partner, and it is not a SQL server. The editor still runs SQL: one `SELECT` is one Sponsored Products list, and the filter, the order and the page are applied to that answer. A write is refused before a request. The rows are not copied into another database. The connection is read-only. Reporting metrics are not columns, and `nextToken` is not followed.

The user field is the Login with Amazon client id. The password is the client secret. The database field is the refresh token. The schema field is the profile id. The client secret and the refresh token are exchanged at `api.amazon.com` for an access token. The access token is sent only to an official advertising host, as an `Authorization: Bearer` header, with `Amazon-Advertising-API-ClientId` and `Amazon-Advertising-API-Scope`. Studio does not put the secret or the refresh token in a URL. An empty host uses `advertising-api.amazon.com`. Any other host is refused, and the refusal does not repeat the host or the secret. The dialog has no TLS panel and no SSH tunnel.

The object tree is one profile and the lists this connection shows: `campaign`, `ad_group` and `product_ad`. One statement asks for 100 rows. When the answer carries `nextToken`, the rest of the profile is not requested. Sponsored Brands and Sponsored Display are not this connection.

## SQL grammar

[`src/lib/db/providers/sql/amazonads/sql-grammar.ts`](../../src/lib/db/providers/sql/amazonads/sql-grammar.ts) declares `AMAZONADS_SQL_GRAMMAR`, whose `grammar` is `AMAZON_ADS_GRAMMAR`. `readsSqlText` is `true`. Redaction is `sql` with `"` as its name quote.

Comments are `--` and `/* */`. `#` is code. `//` is not a comment. Names are double-quoted. Format uses sql-formatter's MySQL language (the grammar's `formatterLanguage`).

The editor offers only the words this subset runs (`completionWords` with `lists: "only"`): `SELECT`, `FROM`, `WHERE`, `AND`, `ORDER BY`, `ASC`, `DESC`, `LIMIT`, `OFFSET`, `LIKE`, `IS NULL` and `IS NOT NULL`. It does not offer `INSERT`, `UPDATE`, `DELETE`, `JOIN`, `COUNT` or the shared function list. A field whose name contains a dot, such as `campaign.name`, is completed as that one word. The `SELECT` snippet is a statement this connection can run.

What the provider actually runs is the subset, and a statement outside it fails before a request:

- `SELECT` columns or `*` from one listed resource, such as `campaign`, `ad_group` or `product_ad`. A field is the name this connection lists, such as `campaign.state` or `product_ad.asin`.
- `WHERE` comparisons (`=`, `!=`, `<>`, `<`, `>`, `<=`, `>=`), `LIKE`, `IS NULL` and `IS NOT NULL`. `AND` only. Text values are quoted (`campaign.state = 'ENABLED'`). A number is unquoted. `LIKE` applies to a text field.
- `ORDER BY` one field. A null sorts last.
- `LIMIT` and `OFFSET`, capped at 100 rows. The default limit is 100. The API is asked for one page of at most 100, and Studio keeps the page locally. An `OFFSET` of 100 or more returns no rows and does not call the API.

`COUNT(*)`, `OR`, a join, `IN`, `DISTINCT`, a second statement, and a parameter list are refused.

## SQL writing

[`amazonads/sql-writing.ts`](../../src/lib/db/providers/sql/amazonads/sql-writing.ts) declares how a generated statement spells a literal, a name and a bind, and it is this engine's row of `SQL_WRITING`.

A literal is written by `literalStandard` and read back by `unquoteStandard`. A name is quoted by `identifierDoubleQuoted`. There is no placeholder: the API does not bind parameters, and `query()` refuses a parameter list.

`inlineEdit` uses `INSTANT_TYPE_NAMES`, `FLOAT64_TYPE_NAMES` and `EXACT_DECIMAL_TYPE_NAMES`. The provider does not offer inline row edit.

The module's `export` field writes a result export from `STANDARD_DDL_TYPES`, `NOTHING_STANDS_ALONE`, `NO_BARE_SPELLING`, `NULL_NON_FINITE` and `binaryStandardHex`.

## Connection string

[`connection-string.ts`](../../src/lib/db/providers/sql/amazonads/connection-string.ts) shows no connection string scheme. There is no `readTls`. There is no `paste`. There is no seed load check.

## Execution UI

[`execution-ui.ts`](../../src/lib/db/providers/sql/amazonads/execution-ui.ts) names `COMMIT` on the rolled-back notice. The consent card has no consent deadline.

## Object edit (#789)

Amazon Ads objects are not edited as source from the object tree. No kind declares `hasSource`. The absence is the one `tests/isolated/object-edit-declarations.test.ts` holds for this type-id. No kind declares `acceptsRowWrites` or `acceptsSourceEdits`. The connection is read-only.

## Migration DDL

[`AMAZONADS_MIGRATION_DDL`](../../src/lib/db/providers/sql/amazonads/migration-ddl.ts) declines the whole diff. `refusal` is the one line the migration prints after its header, and `transactionWrapper` is `null`.

The refusal reason it prints, verbatim:

- "Amazon Ads object changes are not generated here; this connection is read-only."

## Query

A `SELECT` is `POST /sp/campaigns/list`, `POST /sp/adGroups/list` or `POST /sp/productAds/list` with `{"maxResults":100}`. The content type and the accept header are the Sponsored Products v3 vendor type for that list: `application/vnd.spCampaign.v3+json`, `application/vnd.spAdGroup.v3+json` or `application/vnd.spProductAd.v3+json`. `SELECT` of named columns returns those columns. `SELECT *` returns the columns this connection lists for that resource. An id is kept as text. `budget` is the budget object's amount, kept as a number, and `budgetType` is its type. `defaultBid` is kept as a number. A nested value is JSON. A `LIMIT` above 100 warns that the read is 100. An `OFFSET` past 100 returns no rows and a warning, and it does not call the API. An answer that carries `nextToken` warns that the rest of the profile was not read. Generate Query omits `WHERE 1=1` (`supportsConstantPredicate` is false). `EXPLAIN` is not offered (`supportsExplain` is false). There is no maintenance operation. There is no agent language pack: `AGENT_STATEMENT_LANGUAGE` is null for this type-id, and MCP stays closed.
