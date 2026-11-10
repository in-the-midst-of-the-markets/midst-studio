# Microsoft Dynamics Provider

Microsoft Dynamics is its own connection type. Studio reaches one Dynamics 365 organization over the Dataverse Web API (`https://contoso.crm.dynamics.com/api/data/v9.2`). It is not a SQL server. The editor still runs SQL: one `SELECT` or `COUNT(*)` is one OData read of one standard table. A write is refused before a request. The rows are not copied into another database. The connection is read-only. Finance and Operations, Business Central, and custom tables are not this connection.

The connection is an organization host, such as `contoso.crm.dynamics.com`, and either an access token or a client secret. A client secret also needs the application (client) id and the directory (tenant) id. The secret is sent only to `login.microsoftonline.com`. The access token is sent only to that organization host, over TLS, on the shared HTTP transport, with `OData-Version: 4.0`. That path does not use global fetch, so a proxy setting cannot carry the secret. Any other host is refused, and the refusal does not repeat the host or the secret. A redirect is not followed. Studio refreshes a client-secret token until it expires. A pasted access token is not refreshed. The dialog has no TLS panel and no SSH tunnel.

The object tree is one organization and the standard tables this connection shows: accounts, contacts, leads, opportunities, systemusers, tasks, and incidents. One statement stops at 1000 rows.

## SQL grammar

[`src/lib/db/providers/sql/dynamics/sql-grammar.ts`](../../src/lib/db/providers/sql/dynamics/sql-grammar.ts) declares `DYNAMICS_GRAMMAR`. `readsSqlText` is `true`. Redaction is `sql` with `"` as its name quote.

Comments are `--` and `/* */`. `#` is code. `//` is not a comment. Names are double-quoted. Format uses sql-formatter's MySQL language (the grammar's `formatterLanguage`).

The editor offers only the words this subset runs (`completionWords` with `lists: "only"`): `SELECT`, `FROM`, `WHERE`, `AND`, `ORDER BY`, `ASC`, `DESC`, `LIMIT`, `OFFSET`, `COUNT`, `LIKE`, `IS NULL` and `IS NOT NULL`. It does not offer `INSERT`, `UPDATE`, `DELETE`, `JOIN` or the shared function list. A field whose name contains a dot is completed as that one word. `SELECT` and `COUNT` are snippets, and each one is a statement this connection can run.

What the provider actually runs is the subset, and a statement outside it fails before a request:

- `SELECT` columns or `*` from one listed table, such as `accounts` or `contacts`. A lookup such as `parentcustomerid` is one name. The request asks for `_parentcustomerid_value`.
- `WHERE` comparisons (`=`, `!=`, `<>`, `<`, `>`, `<=`, `>=`), `LIKE`, `IS NULL` and `IS NOT NULL`. `AND` only. Text `LIKE` is a prefix (`abc%`), a suffix (`%abc`), or a contains (`%abc%`). A date is `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM:SSZ`. A GUID is written in quotes.
- `ORDER BY` one field. Dataverse applies it.
- `LIMIT` and `OFFSET`, capped at 1000 rows. The default limit is 100.
- `COUNT(*)` is `GET /api/data/v9.2/<table>/$count`.

`OR`, a join, `IN`, `DISTINCT`, a second statement, and a parameter list are refused.

## SQL writing

[`dynamics/sql-writing.ts`](../../src/lib/db/providers/sql/dynamics/sql-writing.ts) declares how a generated statement spells a literal, a name and a bind, and it is this engine's row of `SQL_WRITING`.

A literal is written by `literalStandard` and read back by `unquoteStandard`. A name is quoted by `identifierDoubleQuoted`. There is no placeholder: the API does not bind parameters, and `query()` refuses a parameter list.

`inlineEdit` uses `INSTANT_TYPE_NAMES`, `FLOAT64_TYPE_NAMES` and `EXACT_DECIMAL_TYPE_NAMES`. The provider does not offer inline row edit.

The module's `export` field writes a result export from `STANDARD_DDL_TYPES`, `NOTHING_STANDS_ALONE`, `NO_BARE_SPELLING`, `NULL_NON_FINITE` and `binaryStandardHex`.

## Connection string

[`connection-string.ts`](../../src/lib/db/providers/sql/dynamics/connection-string.ts) shows no connection string scheme. There is no `readTls`. There is no `paste`. There is no seed load check.

## Execution UI

[`execution-ui.ts`](../../src/lib/db/providers/sql/dynamics/execution-ui.ts) names `COMMIT` on the rolled-back notice. The consent card has no consent deadline.

## Object edit (#789)

Dynamics objects are not edited as source from the object tree. No kind declares `hasSource`. The absence is the one `tests/isolated/object-edit-declarations.test.ts` holds for this type-id. No kind declares `acceptsRowWrites` or `acceptsSourceEdits`. The connection is read-only.

## Migration DDL

[`DYNAMICS_MIGRATION_DDL`](../../src/lib/db/providers/sql/dynamics/migration-ddl.ts) declines the whole diff. `refusal` is the one line the migration prints after its header, and `transactionWrapper` is `null`.

The refusal reason it prints, verbatim:

- "Dynamics object changes are not generated here; this connection is read-only."

## Query

A `SELECT` is `GET /api/data/v9.2/<table>` with `$select`, `$filter`, `$orderby`, `$top` and `$skip`. `COUNT(*)` is `GET /api/data/v9.2/<table>/$count`. `statecode` is the option-set number Dataverse stores. `SELECT` of named columns returns those columns. `SELECT *` returns the columns this connection lists for that table. A `LIMIT` above 1000 warns that the read is 1000. An `OFFSET` past 1000 returns no rows and a warning, and it does not call the API. Generate Query omits `WHERE 1=1` (`supportsConstantPredicate` is false). `EXPLAIN` is not offered (`supportsExplain` is false). There is no maintenance operation. There is no agent language pack: `AGENT_STATEMENT_LANGUAGE` is null for this type-id, and MCP stays closed.
