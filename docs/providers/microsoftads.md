# Microsoft Ads Provider

Microsoft Ads is its own connection type. Studio reaches one Microsoft Advertising account over the Campaign Management REST API (`https://campaign.api.bingads.microsoft.com/CampaignManagement/v13`). It is not a SQL server. The editor still runs SQL: one `SELECT` is one read of one standard resource, and the filter, the order and the page are applied to that answer. A write is refused before a request. The rows are not copied into another database. The connection is read-only. LinkedIn Ads, Microsoft Clarity, and Google Ads are not this connection. Performance reports are a separate service and are not called, so this connection has no click, impression or cost column.

The password is one JSON object with `accessToken` and `developerToken` (`access_token` and `developer_token` are the same two fields). Both are sent only to the Campaign Management host, on `Authorization` and `DeveloperToken`. Studio does not exchange them and does not refresh a pasted access token. The user field is the customer id and is sent as `CustomerId`. The database field is the account id and is sent as `CustomerAccountId` and, for a campaign read, as `AccountId`. Both ids are whole numbers of at most 15 digits. The host is `campaign.api.bingads.microsoft.com`, or `campaign.api.sandbox.bingads.microsoft.com` for the sandbox. An empty host uses the production host. Any other host is refused, and the refusal does not repeat the host or the secret. The dialog has no TLS panel and no SSH tunnel.

The object tree is one account and the standard resources this connection shows: `campaign`, `ad_group`, `ad`, and `keyword`. One statement stops at 1000 rows. A campaign read asks for every campaign type, because an omitted type returns Search campaigns only.

## SQL grammar

[`src/lib/db/providers/sql/microsoftads/sql-grammar.ts`](../../src/lib/db/providers/sql/microsoftads/sql-grammar.ts) declares `MICROSOFTADS_GRAMMAR`. `readsSqlText` is `true`. Redaction is `sql` with `"` as its name quote.

Comments are `--` and `/* */`. `#` is code. `//` is not a comment. Names are double-quoted. Format uses sql-formatter's MySQL language (the grammar's `formatterLanguage`).

The editor offers only the words this subset runs (`completionWords` with `lists: "only"`): `SELECT`, `FROM`, `WHERE`, `AND`, `ORDER BY`, `ASC`, `DESC`, `LIMIT`, `OFFSET`, `LIKE`, `IS NULL` and `IS NOT NULL`. It does not offer `INSERT`, `UPDATE`, `DELETE`, `JOIN`, `COUNT` or the shared function list. A field whose name contains a dot, such as `campaign.name`, is completed as that one word. The `SELECT` snippet is a statement this connection can run.

What the provider actually runs is the subset, and a statement outside it fails before a request:

- `SELECT` columns or `*` from one listed resource, such as `campaign` or `keyword`. A field is the name this connection lists, such as `campaign.status` or `keyword.text`.
- `WHERE` comparisons (`=`, `!=`, `<>`, `<`, `>`, `<=`, `>=`), `LIKE`, `IS NULL` and `IS NOT NULL`. `AND` only. Text and status values are quoted (`campaign.status = 'Active'`). A number is unquoted.
- `ORDER BY` one field. A null sorts last.
- `LIMIT` and `OFFSET`, capped at 1000 rows. The default limit is 100. The API returns the whole list for that one parent, and Studio keeps the page locally. An `OFFSET` of 1000 or more returns no rows and does not call the API.

An ad group read needs `campaign.id = <id>`, because Microsoft Ads lists ad groups one campaign at a time. An ad read and a keyword read need `ad_group.id = <id>` for the same reason. `COUNT(*)`, `OR`, a join, `IN`, `DISTINCT`, a second statement, and a parameter list are refused.

## SQL writing

[`microsoftads/sql-writing.ts`](../../src/lib/db/providers/sql/microsoftads/sql-writing.ts) declares how a generated statement spells a literal, a name and a bind, and it is this engine's row of `SQL_WRITING`.

A literal is written by `literalStandard` and read back by `unquoteStandard`. A name is quoted by `identifierDoubleQuoted`. There is no placeholder: the API does not bind parameters, and `query()` refuses a parameter list.

`inlineEdit` uses `INSTANT_TYPE_NAMES`, `FLOAT64_TYPE_NAMES` and `EXACT_DECIMAL_TYPE_NAMES`. The provider does not offer inline row edit.

The module's `export` field writes a result export from `STANDARD_DDL_TYPES`, `NOTHING_STANDS_ALONE`, `NO_BARE_SPELLING`, `NULL_NON_FINITE` and `binaryStandardHex`.

## Connection string

[`connection-string.ts`](../../src/lib/db/providers/sql/microsoftads/connection-string.ts) shows no connection string scheme. There is no `readTls`. There is no `paste`. There is no seed load check.

## Execution UI

[`execution-ui.ts`](../../src/lib/db/providers/sql/microsoftads/execution-ui.ts) names `COMMIT` on the rolled-back notice. The consent card has no consent deadline.

## Object edit (#789)

Microsoft Ads objects are not edited as source from the object tree. No kind declares `hasSource`. The absence is the one `tests/isolated/object-edit-declarations.test.ts` holds for this type-id. No kind declares `acceptsRowWrites` or `acceptsSourceEdits`. The connection is read-only.

## Migration DDL

[`MICROSOFTADS_MIGRATION_DDL`](../../src/lib/db/providers/sql/microsoftads/migration-ddl.ts) declines the whole diff. `refusal` is the one line the migration prints after its header, and `transactionWrapper` is `null`.

The refusal reason it prints, verbatim:

- "Microsoft Ads object changes are not generated here; this connection is read-only."

## Query

A campaign `SELECT` is `POST /CampaignManagement/v13/Campaigns/QueryByAccountId` with `AccountId` and every campaign type. An ad group `SELECT` is `POST /CampaignManagement/v13/AdGroups/QueryByCampaignId`. An ad `SELECT` is `POST /CampaignManagement/v13/Ads/QueryByAdGroupId`. A keyword `SELECT` is `POST /CampaignManagement/v13/Keywords/QueryByAdGroupId`. `SELECT` of named columns returns those columns. `SELECT *` returns the columns this connection lists for that resource. A numeric id is kept as the API sent it, often a number, and a nested value is JSON. A `LIMIT` above 1000 warns that the read is 1000. An `OFFSET` past 1000 returns no rows and a warning, and it does not call the API. An answer whose `Errors` list is not empty is a failed read. Generate Query omits `WHERE 1=1` (`supportsConstantPredicate` is false). `EXPLAIN` is not offered (`supportsExplain` is false). There is no maintenance operation. There is no agent language pack: `AGENT_STATEMENT_LANGUAGE` is null for this type-id, and MCP stays closed.
