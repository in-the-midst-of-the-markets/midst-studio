# Xero Provider

Xero is its own connection type. Studio reaches one organisation over the Accounting API (`https://api.xero.com`). It is not a SQL server. The editor still runs SQL: one `SELECT` or `COUNT(*)` is one list request. A write is refused before a request. The rows are not copied into another database. The connection is read-only.

The connection is an OAuth access token in the password field and the organisation id in the database field. The token lasts about 30 minutes. Studio does not refresh it: a Xero refresh token rotates, and refreshing it without storing the new one locks the organisation out. The API host is `api.xero.com`. The token is sent only there, over TLS, on the shared HTTP transport, with the organisation id in `Xero-Tenant-Id`. That path does not use global fetch, so a proxy setting cannot carry the token. Any other host, including `identity.xero.com`, is refused, and the refusal does not repeat the host or the token. A redirect is not followed. The dialog has no TLS panel and no SSH tunnel.

The object tree is one organisation and the lists this connection shows: invoices, contacts, accounts, payments, bank transactions, credit notes, and the other Accounting list endpoints. Profit and loss, the balance sheet, and attachments stay out. A page is 100 rows. One statement stops at 1000 rows.

## SQL grammar

[`src/lib/db/providers/sql/xero/sql-grammar.ts`](../../src/lib/db/providers/sql/xero/sql-grammar.ts) declares `XERO_GRAMMAR`. `readsSqlText` is `true`. Redaction is `sql` with `"` as its name quote.

Comments are `--` and `/* */`. `#` is code. `//` is not a comment. Names are double-quoted. Format uses sql-formatter's MySQL language (the grammar's `formatterLanguage`).

The editor offers only the words this subset runs (`completionWords` with `lists: "only"`): `SELECT`, `FROM`, `WHERE`, `AND`, `ORDER BY`, `ASC`, `DESC`, `LIMIT`, `OFFSET`, `COUNT` and `LIKE`. It does not offer `INSERT`, `UPDATE`, `DELETE`, `JOIN` or the shared function list. `SELECT` and `COUNT` are snippets, and each one is a statement this connection can run.

What the provider actually runs is the subset, and a statement outside it fails before a request:

- `SELECT` columns or `*` from one listed endpoint, such as `Invoices` or `Contacts`. A dotted field such as `Contact.Name` is one name.
- `WHERE` comparisons (`=`, `!=`, `<>`, `<`, `>`, `<=`, `>=`) and `LIKE`. `AND` only. Text `LIKE` is a prefix (`abc%`), a suffix (`%abc`), or a contains (`%abc%`). A date is `YYYY-MM-DD`. An id is a UUID.
- `ORDER BY` one field.
- `LIMIT` and `OFFSET`, capped at 1000 rows.
- `COUNT(*)` counts the same filtered list. A paged list uses `pagination.itemCount` when Xero sends it.

`OR`, a join, `IN`, `DISTINCT`, a second statement, and a parameter list are refused.

## SQL writing

[`xero/sql-writing.ts`](../../src/lib/db/providers/sql/xero/sql-writing.ts) declares how a generated statement spells a literal, a name and a bind, and it is this engine's row of `SQL_WRITING`.

A literal is written by `literalStandard` and read back by `unquoteStandard`. A name is quoted by `identifierDoubleQuoted`. There is no placeholder: the API does not bind parameters, and `query()` refuses a parameter list.

`inlineEdit` uses `INSTANT_TYPE_NAMES`, `FLOAT64_TYPE_NAMES` and `EXACT_DECIMAL_TYPE_NAMES`. The provider does not offer inline row edit.

The module's `export` field writes a result export from `STANDARD_DDL_TYPES`, `NOTHING_STANDS_ALONE`, `NO_BARE_SPELLING`, `NULL_NON_FINITE` and `binaryStandardHex`.

## Connection string

[`connection-string.ts`](../../src/lib/db/providers/sql/xero/connection-string.ts) shows no connection string scheme. There is no `readTls`. There is no `paste`. There is no seed load check.

## Execution UI

[`execution-ui.ts`](../../src/lib/db/providers/sql/xero/execution-ui.ts) names `COMMIT` on the rolled-back notice. The consent card has no consent deadline.

## Object edit (#789)

Xero objects are not edited as source from the object tree. No kind declares `hasSource`. The absence is the one `tests/isolated/object-edit-declarations.test.ts` holds for this type-id. No kind declares `acceptsRowWrites` or `acceptsSourceEdits`. The connection is read-only.

## Migration DDL

[`XERO_MIGRATION_DDL`](../../src/lib/db/providers/sql/xero/migration-ddl.ts) declines the whole diff. `refusal` is the one line the migration prints after its header, and `transactionWrapper` is `null`.

The refusal reason it prints, verbatim:

- "Xero object changes are not generated here; this connection is read-only."

## Query

A list is `GET /api.xro/2.0/{Resource}` with `where`, `order` and, for a paged resource, `page`. Nested objects flatten one level, so `Contact.Name` is a column, and an array such as line items comes back as text. `SELECT` of named columns returns those columns. `SELECT *` returns the flattened keys. A `LIMIT` above 1000 warns that the read is 1000. An `OFFSET` past 1000 returns no rows and a warning, and it does not call the API. Generate Query omits `WHERE 1=1` (`supportsConstantPredicate` is false). `EXPLAIN` is not offered (`supportsExplain` is false). There is no maintenance operation. There is no agent language pack: `AGENT_STATEMENT_LANGUAGE` is null for this type-id, and MCP stays closed.
