# Google Ads Provider

Google Ads is its own connection type. Studio reaches one Google Ads customer over the Google Ads API (`https://googleads.googleapis.com/v26/customers/{customerId}/googleAds:search`). It is not a SQL server. The editor still runs SQL: one `SELECT` is one Google Ads Query Language search of one standard resource. A write is refused before a request. The rows are not copied into another database. The connection is read-only. Google Ad Manager, Display & Video 360, Search Ads 360, and Google Analytics are not this connection.

The password is either an access token or a service-account key JSON. An access token is sent only to `googleads.googleapis.com`. A service-account key is exchanged only at `oauth2.googleapis.com` for the scope `https://www.googleapis.com/auth/adwords`, and the private key is not sent to the Ads API. Both calls use the shared HTTP transport, so a proxy setting cannot carry the credential. A redirect is not followed. Studio refreshes a service-account token until it expires. A pasted access token is not refreshed. The customer id is the 10-digit id in the database field, with or without hyphens. A manager customer id, when the token reaches that customer through one, is the user field and is sent as `login-customer-id`. Leave the user field empty when the token belongs to the customer itself. Any other host is refused, and the refusal does not repeat the host or the secret. The dialog has no TLS panel and no SSH tunnel. A developer token is not sent and there is no field for one: Google retired that header, and access is the Cloud project's.

The object tree is one customer and the standard resources this connection shows: `customer`, `campaign`, `ad_group`, `ad_group_ad`, and `keyword_view`. One statement stops at 1000 rows. `cost_micros` stays in micros.

## SQL grammar

[`src/lib/db/providers/sql/googleads/sql-grammar.ts`](../../src/lib/db/providers/sql/googleads/sql-grammar.ts) declares `GOOGLEADS_GRAMMAR`. `readsSqlText` is `true`. Redaction is `sql` with `"` as its name quote.

Comments are `--` and `/* */`. `#` is code. `//` is not a comment. Names are double-quoted. Format uses sql-formatter's MySQL language (the grammar's `formatterLanguage`).

The editor offers only the words this subset runs (`completionWords` with `lists: "only"`): `SELECT`, `FROM`, `WHERE`, `AND`, `ORDER BY`, `ASC`, `DESC`, `LIMIT`, `OFFSET`, `LIKE`, `IS NULL` and `IS NOT NULL`. It does not offer `INSERT`, `UPDATE`, `DELETE`, `JOIN`, `COUNT` or the shared function list. A field whose name contains a dot, such as `campaign.name` or `metrics.clicks`, is completed as that one word. The `SELECT` snippet is a statement this connection can run.

What the provider actually runs is the subset, and a statement outside it fails before a request:

- `SELECT` columns or `*` from one listed resource, such as `campaign` or `keyword_view`. A field is its Google Ads Query Language name, such as `campaign.status` or `ad_group_criterion.keyword.text`.
- `WHERE` comparisons (`=`, `!=`, `<>`, `<`, `>`, `<=`, `>=`), `LIKE`, `IS NULL` and `IS NOT NULL`. `AND` only. Text and status values are quoted (`campaign.status = 'ENABLED'`). A date is `YYYY-MM-DD`. A number is unquoted.
- `ORDER BY` one field.
- `LIMIT` and `OFFSET`, capped at 1000 rows. The default limit is 100. Google Ads Query Language has no `OFFSET`, so Studio asks for `offset + limit` rows and drops the first `offset` locally. An `OFFSET` of 1000 or more returns no rows and does not call the API.

`COUNT(*)`, `OR`, a join, `IN`, `DISTINCT`, a second statement, and a parameter list are refused.

## SQL writing

[`googleads/sql-writing.ts`](../../src/lib/db/providers/sql/googleads/sql-writing.ts) declares how a generated statement spells a literal, a name and a bind, and it is this engine's row of `SQL_WRITING`.

A literal is written by `literalStandard` and read back by `unquoteStandard`. A name is quoted by `identifierDoubleQuoted`. There is no placeholder: the API does not bind parameters, and `query()` refuses a parameter list.

`inlineEdit` uses `INSTANT_TYPE_NAMES`, `FLOAT64_TYPE_NAMES` and `EXACT_DECIMAL_TYPE_NAMES`. The provider does not offer inline row edit.

The module's `export` field writes a result export from `STANDARD_DDL_TYPES`, `NOTHING_STANDS_ALONE`, `NO_BARE_SPELLING`, `NULL_NON_FINITE` and `binaryStandardHex`.

## Connection string

[`connection-string.ts`](../../src/lib/db/providers/sql/googleads/connection-string.ts) shows no connection string scheme. There is no `readTls`. There is no `paste`. There is no seed load check.

## Execution UI

[`execution-ui.ts`](../../src/lib/db/providers/sql/googleads/execution-ui.ts) names `COMMIT` on the rolled-back notice. The consent card has no consent deadline.

## Object edit (#789)

Google Ads objects are not edited as source from the object tree. No kind declares `hasSource`. The absence is the one `tests/isolated/object-edit-declarations.test.ts` holds for this type-id. No kind declares `acceptsRowWrites` or `acceptsSourceEdits`. The connection is read-only.

## Migration DDL

[`GOOGLEADS_MIGRATION_DDL`](../../src/lib/db/providers/sql/googleads/migration-ddl.ts) declines the whole diff. `refusal` is the one line the migration prints after its header, and `transactionWrapper` is `null`.

The refusal reason it prints, verbatim:

- "Google Ads object changes are not generated here; this connection is read-only."

## Query

A `SELECT` is `POST /v26/customers/{customerId}/googleAds:search` with `{"query":"<GAQL>"}`. The page size is the API's own. Studio does not follow `nextPageToken`, because one page covers the 1000-row cap. `SELECT` of named columns returns those columns. `SELECT *` returns the columns this connection lists for that resource. A numeric id or `cost_micros` is kept as the API sent it, often a string, and is not divided. A `LIMIT` above 1000 warns that the read is 1000. An `OFFSET` past 1000 returns no rows and a warning, and it does not call the API. Generate Query omits `WHERE 1=1` (`supportsConstantPredicate` is false). `EXPLAIN` is not offered (`supportsExplain` is false). There is no maintenance operation. There is no agent language pack: `AGENT_STATEMENT_LANGUAGE` is null for this type-id, and MCP stays closed.
