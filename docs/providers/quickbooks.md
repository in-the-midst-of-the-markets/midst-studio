# QuickBooks Online Provider

QuickBooks Online is its own connection type. Studio reaches a company over the Accounting query API (`https://quickbooks.api.intuit.com`). It is not QuickBooks Desktop, it is not a SQL server, and the rows are not copied into another database. The editor still runs SQL: one `SELECT` or `COUNT(*)` is one query. A write is refused before a request. The connection is read-only.

The connection is an OAuth access token in the password field and the company id in the database field. The token lasts about an hour. Studio does not refresh it: an Intuit refresh token rotates, and refreshing it without storing the new one locks the company out. The API host is `quickbooks.api.intuit.com`, or `sandbox-quickbooks.api.intuit.com` for a sandbox company. The token is sent only there, over TLS, on the shared HTTP transport. That path does not use global fetch, so a proxy setting cannot carry the token. Any other host, including `oauth.platform.intuit.com`, is refused, and the refusal does not repeat the host or the token. A redirect is not followed. The dialog has no TLS panel and no SSH tunnel.

The object tree is one company and the entities this connection lists. The query uses minor version 75. A page is at most 1000 rows. When `LIMIT` is omitted the page is 100, which is the API's own default.

## SQL grammar

[`src/lib/db/providers/sql/quickbooks/sql-grammar.ts`](../../src/lib/db/providers/sql/quickbooks/sql-grammar.ts) declares `QUICKBOOKS_GRAMMAR`. `readsSqlText` is `true`. Redaction is `sql` with `"` as its name quote.

Comments are `--` and `/* */`. `#` is code. `//` is not a comment. Names are double-quoted. Format uses sql-formatter's MySQL language (the grammar's `formatterLanguage`).

The editor offers only the words this subset runs (`completionWords` with `lists: "only"`): `SELECT`, `FROM`, `WHERE`, `AND`, `ORDER BY`, `ASC`, `DESC`, `LIMIT`, `OFFSET`, `COUNT`, `LIKE` and `IN`. It does not offer `INSERT`, `UPDATE`, `DELETE`, `JOIN`, `OR` or the shared function list. `SELECT` and `COUNT` are snippets, and each one is a statement this connection can run. Generate Query names the columns when there are at most eight, and writes `SELECT *` under a comment when the table has more fields than that.

What the provider actually runs is the subset, and a statement outside it fails before a request:

- `SELECT` columns or `*` from one listed entity, such as `Customer` or `Invoice`. A dotted field such as `CustomerRef.value` is one name.
- `WHERE` equalities and comparisons (`=`, `<`, `>`, `<=`, `>=`), `LIKE`, and `IN` of quoted values, numbers, or `true` and `false`. `AND` only.
- `ORDER BY` one field. The query spells that `ORDERBY`.
- `LIMIT` becomes `MAXRESULTS`, capped at 1000. `OFFSET` is 0-based and becomes `STARTPOSITION`, which is 1-based.
- `COUNT(*)` is the API's count. It does not take `ORDER BY` or `LIMIT`.

`OR`, a join, a second statement, and a parameter list are refused.

## SQL writing

[`quickbooks/sql-writing.ts`](../../src/lib/db/providers/sql/quickbooks/sql-writing.ts) declares how a generated statement spells a literal, a name and a bind, and it is this engine's row of `SQL_WRITING`.

A literal is written by `literalStandard` and read back by `unquoteStandard`. A name is quoted by `identifierDoubleQuoted`. There is no placeholder: the API does not bind parameters, and `query()` refuses a parameter list.

`inlineEdit` uses `INSTANT_TYPE_NAMES`, `FLOAT64_TYPE_NAMES` and `EXACT_DECIMAL_TYPE_NAMES`. The provider does not offer inline row edit.

The module's `export` field writes a result export from `STANDARD_DDL_TYPES`, `NOTHING_STANDS_ALONE`, `NO_BARE_SPELLING`, `NULL_NON_FINITE` and `binaryStandardHex`.

## Connection string

[`connection-string.ts`](../../src/lib/db/providers/sql/quickbooks/connection-string.ts) shows no connection string scheme. There is no `readTls`. There is no `paste`. There is no seed load check.

## Execution UI

[`execution-ui.ts`](../../src/lib/db/providers/sql/quickbooks/execution-ui.ts) names `COMMIT` on the rolled-back notice. The consent card has no consent deadline.

## Object edit (#789)

QuickBooks Online objects are not edited as source from the object tree. No kind declares `hasSource`. The absence is the one `tests/isolated/object-edit-declarations.test.ts` holds for this type-id. No kind declares `acceptsRowWrites` or `acceptsSourceEdits`. The connection is read-only.

## Migration DDL

[`QUICKBOOKS_MIGRATION_DDL`](../../src/lib/db/providers/sql/quickbooks/migration-ddl.ts) declines the whole diff. `refusal` is the one line the migration prints after its header, and `transactionWrapper` is `null`.

The refusal reason it prints, verbatim:

- "QuickBooks Online object changes are not generated here; this connection is read-only."

## Query

The query is `GET /v3/company/{companyId}/query` with `query` and `minorversion=75`. Nested objects in a row are flattened one level, so `CustomerRef.value` is a column. `SELECT` of named columns returns those columns. `SELECT *` returns the flattened keys. A full page warns that the next page needs a larger `LIMIT` or an `OFFSET`. A `LIMIT` above 1000 warns that the page is 1000.

Generate Query omits `WHERE 1=1` (`supportsConstantPredicate` is false). `EXPLAIN` is not offered (`supportsExplain` is false). There is no maintenance operation. There is no agent language pack: `AGENT_STATEMENT_LANGUAGE` is null for this type-id, and MCP stays closed.
