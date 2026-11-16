# ShipBob Provider

ShipBob is its own connection type. Studio reaches a fulfillment account over the ShipBob API (`https://api.shipbob.com` or `https://sandbox-api.shipbob.com`), version `2026-07`. It is not a SQL server, and the rows are not copied into another database. The editor still runs SQL: one `SELECT` or `COUNT(*)` is one GET. A write is refused before a request. The connection is read-only.

The connection is a personal access token in the password field. An optional channel id in the database field, a whole number from `GET /2026-07/channel`, is sent as `shipbob_channel_id`. Any other value, including an empty field, is not sent. The token is sent only to those two hosts, as a Bearer credential, over TLS, on the shared HTTP transport. That path does not use global fetch, so a proxy setting cannot carry the token. An empty host uses `api.shipbob.com`. Any other host is refused, and the refusal does not repeat the host or the token. A redirect is not followed. The dialog has no TLS panel and no SSH tunnel.

The object tree is one fulfillment account and the lists this connection reads: orders, products, inventory levels, and channels. An order page is at most 100 rows and at most 20 pages. A product page is at most 250 rows, an inventory page at most 100, and the connector follows at most 10 of those pages by the `next` link. Channels arrive in one response.

## SQL grammar

[`src/lib/db/providers/sql/shipbob/sql-grammar.ts`](../../src/lib/db/providers/sql/shipbob/sql-grammar.ts) declares `SHIPBOB_GRAMMAR`. `readsSqlText` is `true`. Redaction is `sql` with `"` as its name quote.

Comments are `--` and `/* */`. `#` is code. `//` is not a comment. Names are double-quoted. Format uses sql-formatter's MySQL language (the grammar's `formatterLanguage`).

The editor offers only the words this subset runs (`completionWords` with `lists: "only"`): `SELECT`, `FROM`, `WHERE`, `AND`, `AS`, `LIMIT`, `OFFSET` and `COUNT`. It does not offer `INSERT`, `UPDATE`, `DELETE`, `JOIN`, `OR`, `ORDER BY` or the shared function list. After `FROM` it offers the lists this connection reads: Order, Product, Inventory and Channel. A select list offers those lists' columns. Inside `WHERE` it offers the filters the list accepts, and the sort orders the API documents (`Newest`, `Oldest`) as quoted values. A field whose name contains a dot is completed as that one word. The snippets are statements this connection can run: orders in a date window, products by SKU, inventory levels, channels, and a channel count. Generate Query names the columns when there are at most eight, and writes `SELECT *` under a comment when the table has more fields than that.

What the provider actually runs is the subset, and a statement outside it fails before a request:

- `SELECT` columns or `*` from one listed table. `Order` is quoted, because `ORDER` is a keyword.
- `WHERE` equalities (`=`) of quoted values, numbers, or `true` and `false`. `AND` only. A column is sent only when that list documents it as a filter. `SortOrder` is `Newest` or `Oldest`. `Id` is a whole number. Dates are a calendar day or an instant such as `2024-07-18T00:00:00Z`.
- `LIMIT` becomes the page size, capped at 100 for orders, 250 for products and 100 for inventory. `OFFSET` must be a multiple of `LIMIT`. Order pages stop at 20. Product and inventory pages stop at 10, following `next`.
- `COUNT(*)` counts the channel list, which arrives in one response. Orders, products and inventory have no total, so they have no count.

`OR`, a join, `ORDER BY`, a second statement, and a parameter list are refused.

## SQL writing

[`shipbob/sql-writing.ts`](../../src/lib/db/providers/sql/shipbob/sql-writing.ts) declares how a generated statement spells a literal, a name and a bind, and it is this engine's row of `SQL_WRITING`.

A literal is written by `literalStandard` and read back by `unquoteStandard`. A name is quoted by `identifierDoubleQuoted`. There is no placeholder: the API does not bind parameters, and `query()` refuses a parameter list.

`inlineEdit` uses `INSTANT_TYPE_NAMES`, `FLOAT64_TYPE_NAMES` and `EXACT_DECIMAL_TYPE_NAMES`. The provider does not offer inline row edit.

The module's `export` field writes a result export from `STANDARD_DDL_TYPES`, `NOTHING_STANDS_ALONE`, `NO_BARE_SPELLING`, `NULL_NON_FINITE` and `binaryStandardHex`.

## Connection string

[`connection-string.ts`](../../src/lib/db/providers/sql/shipbob/connection-string.ts) shows no connection string scheme. There is no `readTls`. There is no `paste`. There is no seed load check.

## Execution UI

[`execution-ui.ts`](../../src/lib/db/providers/sql/shipbob/execution-ui.ts) names `COMMIT` on the rolled-back notice. The consent card has no consent deadline.

## Object edit (#789)

ShipBob objects are not edited as source from the object tree. No kind declares `hasSource`. The absence is the one `tests/isolated/object-edit-declarations.test.ts` holds for this type-id. No kind declares `acceptsRowWrites` or `acceptsSourceEdits`. The connection is read-only.

## Migration DDL

[`SHIPBOB_MIGRATION_DDL`](../../src/lib/db/providers/sql/shipbob/migration-ddl.ts) declines the whole diff. `refusal` is the one line the migration prints after its header, and `transactionWrapper` is `null`.

The refusal reason it prints, verbatim:

- "ShipBob object changes are not generated here; this connection is read-only."

## Query

Orders are `GET /2026-07/order` with `Page`, `Limit`, and the filters `IDs`, `ReferenceIds`, `StartDate`, `EndDate` and `SortOrder`. The body is a list. Products are `GET /2026-07/product` with `PageSize` and `Search`, `SKU` or `Name`. Inventory is `GET /2026-07/inventory-level` with `PageSize` and `SearchBy` or `IsActive`. The next page is the `next` link, and only a link on the same host and path is followed. A missing link is an empty page. Channels are `GET /2026-07/channel`. A full page warns that the next page needs a larger `OFFSET`. A `LIMIT` above the page size warns that the page was capped.

Connect is `GET /2026-07/channel`. A 401 is an authentication failure and a 403 is a refusal. The token is not written into the error.

Generate Query omits `WHERE 1=1` (`supportsConstantPredicate` is false). `EXPLAIN` is not offered (`supportsExplain` is false). There is no maintenance operation. There is no agent language pack: `AGENT_STATEMENT_LANGUAGE` is null for this type-id, and MCP stays closed.
