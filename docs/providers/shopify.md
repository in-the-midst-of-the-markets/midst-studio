# Shopify Provider

Shopify is its own connection type. Studio reaches a shop over the Admin GraphQL API (`https://{shop}.myshopify.com/admin/api/2025-10/graphql.json`). It is not a SQL server, and the rows are not copied into another database. The editor still runs SQL: one `SELECT` or `COUNT(*)` is one query. A write is refused before a request. The connection is read-only.

The connection is an Admin API access token in the password field and the shop host, such as `your-store.myshopify.com`. The token is sent only to a host under `myshopify.com`, over TLS, as the `X-Shopify-Access-Token` header, on the shared HTTP transport. That path does not use global fetch, so a proxy setting cannot carry the token. Any other host is refused, and the refusal does not repeat the host or the token. A redirect is not followed. The dialog has no TLS panel and no SSH tunnel.

The object tree is one shop and the resources this connection lists: `products`, `variants`, `customers`, `orders` and `collections`. A page of the Admin API is at most 250 rows. Studio walks cursors until the statement's `LIMIT` and `OFFSET` are filled, and stops after 1000 rows. When `LIMIT` is omitted the page is 50.

## SQL grammar

[`src/lib/db/providers/sql/shopify/sql-grammar.ts`](../../src/lib/db/providers/sql/shopify/sql-grammar.ts) declares `SHOPIFY_GRAMMAR`. `readsSqlText` is `true`. Redaction is `sql` with `"` as its name quote.

Comments are `--` and `/* */`. `#` is code. `//` is not a comment. Names are double-quoted. Format uses sql-formatter's MySQL language (the grammar's `formatterLanguage`).

The editor offers only the words this subset runs (`completionWords` with `lists: "only"`): `SELECT`, `FROM`, `WHERE`, `AND`, `ORDER BY`, `ASC`, `DESC`, `LIMIT`, `OFFSET`, `COUNT` and `LIKE`. It does not offer `INSERT`, `UPDATE`, `DELETE`, `JOIN`, `OR` or the shared function list. `SELECT` and `COUNT` are snippets, and each one is a statement this connection can run. Generate Query names the columns when there are at most eight, and writes `SELECT *` under a comment when the table has more fields than that.

What the provider actually runs is the subset, and a statement outside it fails before a request:

- `SELECT` columns or `*` from one listed table, such as `products` or `orders`.
- `WHERE` equalities and comparisons (`=`, `!=`, `<>`, `<`, `>`, `<=`, `>=`) and `LIKE`. `AND` only. A filter becomes a Shopify search string.
- `ORDER BY` one field that the resource can sort.
- `LIMIT` is capped at 1000. `OFFSET` walks cursors and is 0-based.
- `COUNT(*)` is the resource's count. It does not take `ORDER BY`, `LIMIT` or `OFFSET`.

`OR`, a join, a second statement, and a parameter list are refused.

## SQL writing

[`shopify/sql-writing.ts`](../../src/lib/db/providers/sql/shopify/sql-writing.ts) declares how a generated statement spells a literal, a name and a bind, and it is this engine's row of `SQL_WRITING`.

A literal is written by `literalStandard` and read back by `unquoteStandard`. A name is quoted by `identifierDoubleQuoted`. There is no placeholder: the API does not bind parameters, and `query()` refuses a parameter list.

`inlineEdit` uses `INSTANT_TYPE_NAMES`, `FLOAT64_TYPE_NAMES` and `EXACT_DECIMAL_TYPE_NAMES`. The provider does not offer inline row edit.

The module's `export` field writes a result export from `STANDARD_DDL_TYPES`, `NOTHING_STANDS_ALONE`, `NO_BARE_SPELLING`, `NULL_NON_FINITE` and `binaryStandardHex`.

## Connection string

[`connection-string.ts`](../../src/lib/db/providers/sql/shopify/connection-string.ts) shows no connection string scheme. There is no `readTls`. There is no `paste`. There is no seed load check.

## Execution UI

[`execution-ui.ts`](../../src/lib/db/providers/sql/shopify/execution-ui.ts) names `COMMIT` on the rolled-back notice. The consent card has no consent deadline.

## Object edit (#789)

Shopify objects are not edited as source from the object tree. No kind declares `hasSource`. The absence is the one `tests/isolated/object-edit-declarations.test.ts` holds for this type-id. No kind declares `acceptsRowWrites` or `acceptsSourceEdits`. The connection is read-only.

## Migration DDL

[`SHOPIFY_MIGRATION_DDL`](../../src/lib/db/providers/sql/shopify/migration-ddl.ts) declines the whole diff. `refusal` is the one line the migration prints after its header, and `transactionWrapper` is `null`.

The refusal reason it prints, verbatim:

- "Shopify object changes are not generated here; this connection is read-only."

## Query

The query is `POST /admin/api/2025-10/graphql.json`. Nested money, a variant's product and a collection's product count are flattened into columns (`totalPrice`, `currencyCode`, `productId`, `productTitle`, `productsCount`). `SELECT` of named columns returns those columns. `SELECT *` returns the flattened keys. A full page warns that the next page needs a larger `LIMIT` or an `OFFSET`. A `LIMIT` above 1000 warns that the read stops at 1000.

Generate Query omits `WHERE 1=1` (`supportsConstantPredicate` is false). `EXPLAIN` is not offered (`supportsExplain` is false). There is no maintenance operation. There is no agent language pack: `AGENT_STATEMENT_LANGUAGE` is null for this type-id, and MCP stays closed.
