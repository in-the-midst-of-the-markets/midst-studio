# Amazon Business Provider

Amazon Business is its own connection type. Studio reaches a buying account over the Amazon Business API (`https://na.business-api.amazon.com`, `https://eu.business-api.amazon.com`, or `https://jp.business-api.amazon.com`). It is not Selling Partner, it is not a SQL server, and the rows are not copied into another database. The editor still runs SQL: one `SELECT` or `COUNT(*)` is one GET. A write is refused before a request. The connection is read-only.

The connection is an LWA client id in the user field, an LWA client secret in the password field, and an LWA refresh token in the database field. The refresh token and the client secret are exchanged at `api.amazon.com` for an access token. The access token is sent only to the regional API host, as the `x-amz-access-token` header, over TLS, on the shared HTTP transport. That path does not use global fetch, so a proxy setting cannot carry the token. An empty host uses `na.business-api.amazon.com`. Any other host is refused, and the refusal does not repeat the host or the token. A redirect is not followed. The dialog has no TLS panel and no SSH tunnel.

Product search also sends the buying user's email, from the schema field, as `x-amz-user-email`. Orders and transactions do not need it. One refresh token is for one region.

The object tree is one buying account and the lists this connection reads: products, orders, the lines on those orders, and reconciliation transactions. A product page is at most 24 rows and at most 13 pages. An order or transaction page is 100 rows, and the connector follows at most 10 of those pages. Orders must span at most 24 hours, which is the API's own limit.

## SQL grammar

[`src/lib/db/providers/sql/amazonbusiness/sql-grammar.ts`](../../src/lib/db/providers/sql/amazonbusiness/sql-grammar.ts) declares `AMAZON_BUSINESS_GRAMMAR`. `readsSqlText` is `true`. Redaction is `sql` with `"` as its name quote.

Comments are `--` and `/* */`. `#` is code. `//` is not a comment. Names are double-quoted. Format uses sql-formatter's MySQL language (the grammar's `formatterLanguage`).

The editor offers only the words this subset runs (`completionWords` with `lists: "only"`): `SELECT`, `FROM`, `WHERE`, `AND`, `AS`, `LIMIT`, `OFFSET` and `COUNT`. It does not offer `INSERT`, `UPDATE`, `DELETE`, `JOIN`, `OR`, `ORDER BY` or the shared function list. After `FROM` it offers the lists this connection reads: Product, Order, LineItem and Transaction. A select list offers those lists' columns. Inside `WHERE` it offers the filters the list accepts, and the product regions the API documents (`US`, `CA`, `UK`, and the rest of that set) as quoted values. A field whose name contains a dot is completed as that one word. The snippets are statements this connection can run: a product search, one ASIN, a day of orders, the lines on those orders, reconciliation transactions, and a product count. Generate Query names the columns when there are at most eight, and writes `SELECT *` under a comment when the table has more fields than that.

What the provider actually runs is the subset, and a statement outside it fails before a request:

- `SELECT` columns or `*` from one listed table. `Order` is quoted, because `ORDER` is a keyword.
- `WHERE` equalities (`=`) of quoted values, numbers, or `true` and `false`. `AND` only. A column is sent only when that list documents it as a filter. Product search needs `Keywords` or `ASIN`, not both. Orders and line items need `StartDate` and `EndDate`, at most 24 hours apart. Transactions need `FeedStartDate` and `FeedEndDate`.
- `LIMIT` becomes the page size, capped at 24 for products and 100 for orders and transactions. `OFFSET` for products must be a multiple of `LIMIT`, and the page number stops at 13. `OFFSET` for orders and transactions must be a multiple of 100, and at most 900.
- `COUNT(*)` reads `matchingProductCount` for a keyword search, or 1 for an ASIN that exists. Orders and transactions have no total, so they have no count.

`OR`, a join, `ORDER BY`, a second statement, and a parameter list are refused.

## SQL writing

[`amazonbusiness/sql-writing.ts`](../../src/lib/db/providers/sql/amazonbusiness/sql-writing.ts) declares how a generated statement spells a literal, a name and a bind, and it is this engine's row of `SQL_WRITING`.

A literal is written by `literalStandard` and read back by `unquoteStandard`. A name is quoted by `identifierDoubleQuoted`. There is no placeholder: the API does not bind parameters, and `query()` refuses a parameter list.

`inlineEdit` uses `INSTANT_TYPE_NAMES`, `FLOAT64_TYPE_NAMES` and `EXACT_DECIMAL_TYPE_NAMES`. The provider does not offer inline row edit.

The module's `export` field writes a result export from `STANDARD_DDL_TYPES`, `NOTHING_STANDS_ALONE`, `NO_BARE_SPELLING`, `NULL_NON_FINITE` and `binaryStandardHex`.

## Connection string

[`connection-string.ts`](../../src/lib/db/providers/sql/amazonbusiness/connection-string.ts) shows no connection string scheme. There is no `readTls`. There is no `paste`. There is no seed load check.

## Execution UI

[`execution-ui.ts`](../../src/lib/db/providers/sql/amazonbusiness/execution-ui.ts) names `COMMIT` on the rolled-back notice. The consent card has no consent deadline.

## Object edit (#789)

Amazon Business objects are not edited as source from the object tree. No kind declares `hasSource`. The absence is the one `tests/isolated/object-edit-declarations.test.ts` holds for this type-id. No kind declares `acceptsRowWrites` or `acceptsSourceEdits`. The connection is read-only.

## Migration DDL

[`AMAZONBUSINESS_MIGRATION_DDL`](../../src/lib/db/providers/sql/amazonbusiness/migration-ddl.ts) declines the whole diff. `refusal` is the one line the migration prints after its header, and `transactionWrapper` is `null`.

The refusal reason it prints, verbatim:

- "Amazon Business object changes are not generated here; this connection is read-only."

## Query

A product search is `GET /products/2020-08-26/products` with `keywords`, `productRegion`, `locale`, `facets=OFFERS`, `pageNumber` and `pageSize`. One ASIN is `GET /products/2020-08-26/products/{asin}` with the same region, locale and facets. The price, currency, merchant and condition come from the first offer. A missing ASIN is an empty page. A full page warns that the next page needs a larger `OFFSET`. A `LIMIT` above 24 warns that the page is 24.

Orders are `GET /reports/2021-01-08/orders` with `startDate` and `endDate`. Line items are the same request with `includeLineItems=true`, one row per line. Transactions are `GET /reconciliation/2021-01-08/transactions` with `feedStartDate` and `feedEndDate`. The next page keeps the original filters and adds `nextPageToken`. A missing token is an empty page.

Generate Query omits `WHERE 1=1` (`supportsConstantPredicate` is false). `EXPLAIN` is not offered (`supportsExplain` is false). There is no maintenance operation. There is no agent language pack: `AGENT_STATEMENT_LANGUAGE` is null for this type-id, and MCP stays closed.
