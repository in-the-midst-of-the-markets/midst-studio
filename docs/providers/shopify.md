# Shopify Provider

Shopify is its own connection type. A statement is ShopifyQL, such as `FROM sales SHOW total_sales`. Studio sends that text through the Admin API `shopifyqlQuery` field at `https://{shop}.myshopify.com/admin/api/2025-10/graphql.json` and reads the table back. The rows are not copied into another database. A write is refused before a request. The connection is read-only.

The connection is an Admin API access token in the password field and the shop host, such as `your-store.myshopify.com`. The token is sent only to a host under `myshopify.com`, over TLS, as the `X-Shopify-Access-Token` header, on the shared HTTP transport. That path does not use global fetch, so a proxy setting cannot carry the token. Any other host is refused, and the refusal does not repeat the host or the token. A redirect is not followed. The dialog has no TLS panel and no SSH tunnel.

The object tree is one shop and the ShopifyQL schemas the 2025-10 reference lists, including `sales`, `sessions`, `customers` and `inventory`. A schema's columns come back with the query, so the tree does not invent metrics.

## SQL grammar

[`src/lib/db/providers/sql/shopify/sql-grammar.ts`](../../src/lib/db/providers/sql/shopify/sql-grammar.ts) declares `SHOPIFY_GRAMMAR`. `readsSqlText` is `true`. Redaction is `sql` with `"` as its name quote.

Comments are `--` and `/* */`. `#` is code. `//` is not a comment. Names are double-quoted. Format uses sql-formatter's MySQL language (the grammar's `formatterLanguage`).

The editor offers the ShopifyQL clauses (`completionWords` with `lists: "only"`): `FROM`, `SHOW`, `WHERE`, `GROUP BY`, `TIMESERIES`, `WITH`, `HAVING`, `SINCE`, `UNTIL`, `DURING`, `COMPARE TO`, `ORDER BY`, `ASC`, `DESC`, `LIMIT`, `OFFSET`, `VISUALIZE`, `AND`, `OR`, `AS` and `TYPE`. It does not offer `SELECT`, `INSERT`, `UPDATE`, `DELETE` or the shared function list. `FROM` and `SHOW` are snippets, and each one is a statement this connection can run. Generate Query asks for the metrics in `SHOW`. A schema has more fields than a list can usefully show.

What the provider sends is one ShopifyQL statement. Comments are stripped and one trailing semicolon is dropped. A statement that does not start with `FROM`, a second statement, and a parameter list are refused before a request. Shopify parses the rest and returns `parseErrors` when the text is not ShopifyQL.

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

The query is `POST /admin/api/2025-10/graphql.json`. The body asks for `shopifyqlQuery`, and the statement is the `query` argument. `parseErrors` is read before `tableData`. A parse error becomes the query error. Columns are the returned `name` values, in order, and a cell is kept as Shopify returned it. There is no cursor paging: one request is the table Shopify returns.

Generate Query omits `WHERE 1=1` (`supportsConstantPredicate` is false). `EXPLAIN` is not offered (`supportsExplain` is false). There is no maintenance operation. There is no agent language pack: `AGENT_STATEMENT_LANGUAGE` is null for this type-id, and MCP stays closed.
