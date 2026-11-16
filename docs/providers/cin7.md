# Cin7 Core Provider

Cin7 Core is its own connection type. Studio reaches an account over the External API v2 (`https://inventory.dearsystems.com/ExternalApi/v2`). It is not Cin7 Omni, it is not a SQL server, and the rows are not copied into another database. The editor still runs SQL: one `SELECT` or `COUNT(*)` is one GET of a listed resource. A write is refused before a request. The connection is read-only.

The connection is an application key in the password field and the account id in the database field. Both are created on the Cin7 Core API setup page, and each company has its own account id. The API host is `inventory.dearsystems.com`. An empty host uses that name. The account id and the application key are sent only there, as the `api-auth-accountid` and `api-auth-applicationkey` headers, over TLS, on the shared HTTP transport. That path does not use global fetch, so a proxy setting cannot carry the key. Any other host is refused, and the refusal does not repeat the host or the key. A redirect is not followed. The dialog has no TLS panel and no SSH tunnel.

The object tree is one account and the resources this connection lists: products, stock, sales, purchases, customers, suppliers, and the reference books (locations, categories, brands, accounts, payment terms, tax rules, units). A page is at most 1000 rows. When `LIMIT` is omitted the page is 100, which is the API's own default. Each application allows about 60 calls a minute.

## SQL grammar

[`src/lib/db/providers/sql/cin7/sql-grammar.ts`](../../src/lib/db/providers/sql/cin7/sql-grammar.ts) declares `CIN7_GRAMMAR`. `readsSqlText` is `true`. Redaction is `sql` with `"` as its name quote.

Comments are `--` and `/* */`. `#` is code. `//` is not a comment. Names are double-quoted. Format uses sql-formatter's MySQL language (the grammar's `formatterLanguage`).

The editor offers only the words this subset runs (`completionWords` with `lists: "only"`): `SELECT`, `FROM`, `WHERE`, `AND`, `AS`, `LIMIT`, `OFFSET` and `COUNT`. It does not offer `INSERT`, `UPDATE`, `DELETE`, `JOIN`, `OR`, `ORDER BY` or the shared function list. After `FROM` it offers the lists this connection reads: Product, Stock, Sale, Purchase, Customer, Supplier, Location, Category, Brand, Account, PaymentTerm, TaxRule and Unit. A select list offers those lists' columns. Inside `WHERE` it offers the filters the list accepts, including `Search` on Sale and Purchase, and the status words Cin7 Core documents (`ORDERED`, `AUTHORISED`, `PAID`, and the rest of that set) as quoted values. A field whose name contains a dot is completed as that one word. The snippets are statements this connection can run: stock on hand, open sales, open purchases, a product, and a count. Generate Query names the columns when there are at most eight, and writes `SELECT *` under a comment when the table has more fields than that.

What the provider actually runs is the subset, and a statement outside it fails before a request:

- `SELECT` columns or `*` from one listed table, such as `Product`, `Stock`, `Sale` or `Purchase`.
- `WHERE` equalities (`=`) of quoted values, numbers, or `true` and `false`. `AND` only. A column is sent only when that resource documents it as a filter. `Sale` and `Purchase` accept `Search`, which matches across the order number, the status, and the customer or supplier name.
- `LIMIT` becomes `Limit`, capped at 1000. `OFFSET` must be a multiple of `LIMIT`, because the API reads pages: page 1 is the first page, and `OFFSET 200 LIMIT 100` is page 3.
- `COUNT(*)` reads the `Total` on a one-row page. It does not take `LIMIT` or `OFFSET`.

`OR`, a join, `ORDER BY`, a second statement, and a parameter list are refused.

## SQL writing

[`cin7/sql-writing.ts`](../../src/lib/db/providers/sql/cin7/sql-writing.ts) declares how a generated statement spells a literal, a name and a bind, and it is this engine's row of `SQL_WRITING`.

A literal is written by `literalStandard` and read back by `unquoteStandard`. A name is quoted by `identifierDoubleQuoted`. There is no placeholder: the API does not bind parameters, and `query()` refuses a parameter list.

`inlineEdit` uses `INSTANT_TYPE_NAMES`, `FLOAT64_TYPE_NAMES` and `EXACT_DECIMAL_TYPE_NAMES`. The provider does not offer inline row edit.

The module's `export` field writes a result export from `STANDARD_DDL_TYPES`, `NOTHING_STANDS_ALONE`, `NO_BARE_SPELLING`, `NULL_NON_FINITE` and `binaryStandardHex`.

## Connection string

[`connection-string.ts`](../../src/lib/db/providers/sql/cin7/connection-string.ts) shows no connection string scheme. There is no `readTls`. There is no `paste`. There is no seed load check.

## Execution UI

[`execution-ui.ts`](../../src/lib/db/providers/sql/cin7/execution-ui.ts) names `COMMIT` on the rolled-back notice. The consent card has no consent deadline.

## Object edit (#789)

Cin7 Core objects are not edited as source from the object tree. No kind declares `hasSource`. The absence is the one `tests/isolated/object-edit-declarations.test.ts` holds for this type-id. No kind declares `acceptsRowWrites` or `acceptsSourceEdits`. The connection is read-only.

## Migration DDL

[`CIN7_MIGRATION_DDL`](../../src/lib/db/providers/sql/cin7/migration-ddl.ts) declines the whole diff. `refusal` is the one line the migration prints after its header, and `transactionWrapper` is `null`.

The refusal reason it prints, verbatim:

- "Cin7 Core object changes are not generated here; this connection is read-only."

## Query

The query is `GET /ExternalApi/v2/{path}` with `Page` and `Limit`. `Product` is `/product` and the rows are `Products`. `Stock` is `/ref/productavailability` and the rows are `ProductAvailabilityList`. `Sale` is `/saleList`. `Purchase` is `/purchaseList`. Nested objects in a row are flattened one level. `SELECT` of named columns returns those columns. `SELECT *` returns the flattened keys. A full page warns that the next page needs a larger `LIMIT` or an `OFFSET`. A `LIMIT` above 1000 warns that the page is 1000. A count reads `Total`.

Generate Query omits `WHERE 1=1` (`supportsConstantPredicate` is false). `EXPLAIN` is not offered (`supportsExplain` is false). There is no maintenance operation. There is no agent language pack: `AGENT_STATEMENT_LANGUAGE` is null for this type-id, and MCP stays closed.
