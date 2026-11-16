# ShipStation Provider

ShipStation is its own connection type. Studio reaches a shipping account over the ShipStation V1 API (`https://ssapi.shipstation.com`). It is not the V2 API, it is not a SQL server, and the rows are not copied into another database. The editor still runs SQL: one `SELECT` or `COUNT(*)` is one GET. A write is refused before a request. The connection is read-only.

The connection is an API key in the user field and an API secret in the password field. They are sent only to `ssapi.shipstation.com`, as HTTP Basic authentication, over TLS, on the shared HTTP transport. That path does not use global fetch, so a proxy setting cannot carry the secret. An empty host uses `ssapi.shipstation.com`. Any other host, including the V2 host, is refused, and the refusal does not repeat the host or the secret. A redirect is not followed. The dialog has no TLS panel and no SSH tunnel.

The object tree is one shipping account and the lists this connection reads: orders, shipments, products, and stores. An order, shipment or product page is at most 500 rows and at most 20 pages. Stores arrive in one response.

## SQL grammar

[`src/lib/db/providers/sql/shipstation/sql-grammar.ts`](../../src/lib/db/providers/sql/shipstation/sql-grammar.ts) declares `SHIPSTATION_GRAMMAR`. `readsSqlText` is `true`. Redaction is `sql` with `"` as its name quote.

Comments are `--` and `/* */`. `#` is code. `//` is not a comment. Names are double-quoted. Format uses sql-formatter's MySQL language (the grammar's `formatterLanguage`).

The editor offers only the words this subset runs (`completionWords` with `lists: "only"`): `SELECT`, `FROM`, `WHERE`, `AND`, `AS`, `LIMIT`, `OFFSET` and `COUNT`. It does not offer `INSERT`, `UPDATE`, `DELETE`, `JOIN`, `OR`, `ORDER BY` or the shared function list. After `FROM` it offers the lists this connection reads: Order, Shipment, Product and Store. A select list offers those lists' columns. Inside `WHERE` it offers the filters the list accepts, and the order statuses the API documents (`awaiting_shipment`, `shipped`, and the rest of that set) as quoted values. A field whose name contains a dot is completed as that one word. The snippets are statements this connection can run: orders awaiting shipment, shipments in a date window, products by SKU, stores, and an order count. Generate Query names the columns when there are at most eight, and writes `SELECT *` under a comment when the table has more fields than that.

What the provider actually runs is the subset, and a statement outside it fails before a request:

- `SELECT` columns or `*` from one listed table. `Order` is quoted, because `ORDER` is a keyword.
- `WHERE` equalities (`=`) of quoted values, numbers, or `true` and `false`. `AND` only. A column is sent only when that list documents it as a filter. `OrderStatus` is one of the documented statuses. `StoreId` is a whole number. Dates are a calendar day or an instant such as `2024-07-18`.
- `LIMIT` becomes `pageSize`, capped at 500. `OFFSET` must be a multiple of `LIMIT`, and pages stop at 20. The page number is one-based.
- `COUNT(*)` reads `total` for orders, shipments and products. Stores have no `total`; the count is the length of the one response.

`OR`, a join, `ORDER BY`, a second statement, and a parameter list are refused.

## SQL writing

[`shipstation/sql-writing.ts`](../../src/lib/db/providers/sql/shipstation/sql-writing.ts) declares how a generated statement spells a literal, a name and a bind, and it is this engine's row of `SQL_WRITING`.

A literal is written by `literalStandard` and read back by `unquoteStandard`. A name is quoted by `identifierDoubleQuoted`. There is no placeholder: the API does not bind parameters, and `query()` refuses a parameter list.

`inlineEdit` uses `INSTANT_TYPE_NAMES`, `FLOAT64_TYPE_NAMES` and `EXACT_DECIMAL_TYPE_NAMES`. The provider does not offer inline row edit.

The module's `export` field writes a result export from `STANDARD_DDL_TYPES`, `NOTHING_STANDS_ALONE`, `NO_BARE_SPELLING`, `NULL_NON_FINITE` and `binaryStandardHex`.

## Connection string

[`connection-string.ts`](../../src/lib/db/providers/sql/shipstation/connection-string.ts) shows no connection string scheme. There is no `readTls`. There is no `paste`. There is no seed load check.

## Execution UI

[`execution-ui.ts`](../../src/lib/db/providers/sql/shipstation/execution-ui.ts) names `COMMIT` on the rolled-back notice. The consent card has no consent deadline.

## Object edit (#789)

ShipStation objects are not edited as source from the object tree. No kind declares `hasSource`. The absence is the one `tests/isolated/object-edit-declarations.test.ts` holds for this type-id. No kind declares `acceptsRowWrites` or `acceptsSourceEdits`. The connection is read-only.

## Migration DDL

[`SHIPSTATION_MIGRATION_DDL`](../../src/lib/db/providers/sql/shipstation/migration-ddl.ts) declines the whole diff. `refusal` is the one line the migration prints after its header, and `transactionWrapper` is `null`.

The refusal reason it prints, verbatim:

- "ShipStation object changes are not generated here; this connection is read-only."

## Query

Orders are `GET /orders` with `page`, `pageSize`, and the filters `orderStatus`, `orderNumber`, `storeId`, `orderDateStart` and `orderDateEnd`. Shipments are `GET /shipments` with `trackingNumber`, `orderNumber`, `carrierCode`, `shipDateStart` and `shipDateEnd`. Products are `GET /products` with `sku` and `name`. The body key is `orders`, `shipments` or `products`, and `total` is the count. Stores are `GET /stores`, one response, read as an array or as `stores`. A full page warns that the next page needs a larger `OFFSET`. A `LIMIT` above 500 warns that the page is 500.

Connect is `GET /stores`. A 401 is an authentication failure and a 403 is a refusal. The secret is not written into the error.

Generate Query omits `WHERE 1=1` (`supportsConstantPredicate` is false). `EXPLAIN` is not offered (`supportsExplain` is false). There is no maintenance operation. There is no agent language pack: `AGENT_STATEMENT_LANGUAGE` is null for this type-id, and MCP stays closed.
