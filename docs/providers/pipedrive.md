# Pipedrive Provider

Pipedrive is its own connection type. Studio reaches one Pipedrive company over the API v2 (`https://api.pipedrive.com/api/v2`). It is not a SQL server. The editor still runs SQL: one `SELECT` is one list of one standard resource, and the filter, the order and the page are applied to that answer. A write is refused before a request. The rows are not copied into another database. The connection is read-only. Custom fields are not columns, and the next page is not requested.

The password is the API token from Settings, Personal preferences, API. It is sent only to the Pipedrive host, as the `x-api-token` header. Studio does not put it in the URL, does not exchange it and does not refresh it. The host is `api.pipedrive.com`, or the company domain, one name ending in `.pipedrive.com`. An empty host uses `api.pipedrive.com`. Any other host is refused, and the refusal does not repeat the host or the token. The dialog has no TLS panel and no SSH tunnel. The user and database fields are not used.

The object tree is one company and the standard resources this connection shows: `deal`, `person`, `organization`, `activity`, `product`, `pipeline` and `stage`. One statement stops at 500 rows, which is the largest page the API returns.

## SQL grammar

[`src/lib/db/providers/sql/pipedrive/sql-grammar.ts`](../../src/lib/db/providers/sql/pipedrive/sql-grammar.ts) declares `PIPEDRIVE_SQL_GRAMMAR`. `readsSqlText` is `true`. Redaction is `sql` with `"` as its name quote.

Comments are `--` and `/* */`. `#` is code. `//` is not a comment. Names are double-quoted. Format uses sql-formatter's MySQL language (the grammar's `formatterLanguage`).

The editor offers only the words this subset runs (`completionWords` with `lists: "only"`): `SELECT`, `FROM`, `WHERE`, `AND`, `ORDER BY`, `ASC`, `DESC`, `LIMIT`, `OFFSET`, `LIKE`, `IS NULL` and `IS NOT NULL`. It does not offer `INSERT`, `UPDATE`, `DELETE`, `JOIN`, `COUNT` or the shared function list. A field whose name contains a dot, such as `deal.title`, is completed as that one word. The `SELECT` snippet is a statement this connection can run.

What the provider actually runs is the subset, and a statement outside it fails before a request:

- `SELECT` columns or `*` from one listed resource, such as `deal` or `stage`. A field is the name this connection lists, such as `deal.status` or `person.name`.
- `WHERE` comparisons (`=`, `!=`, `<>`, `<`, `>`, `<=`, `>=`), `LIKE`, `IS NULL` and `IS NOT NULL`. `AND` only. Text values are quoted (`deal.status = 'open'`). A number is unquoted. `LIKE` applies to a text field.
- `ORDER BY` one field. A null sorts last.
- `LIMIT` and `OFFSET`, capped at 500 rows. The default limit is 100. The API returns one page of at most 500, and Studio keeps the page locally. An `OFFSET` of 500 or more returns no rows and does not call the API.

`COUNT(*)`, `OR`, a join, `IN`, `DISTINCT`, a second statement, and a parameter list are refused.

## SQL writing

[`pipedrive/sql-writing.ts`](../../src/lib/db/providers/sql/pipedrive/sql-writing.ts) declares how a generated statement spells a literal, a name and a bind, and it is this engine's row of `SQL_WRITING`.

A literal is written by `literalStandard` and read back by `unquoteStandard`. A name is quoted by `identifierDoubleQuoted`. There is no placeholder: the API does not bind parameters, and `query()` refuses a parameter list.

`inlineEdit` uses `INSTANT_TYPE_NAMES`, `FLOAT64_TYPE_NAMES` and `EXACT_DECIMAL_TYPE_NAMES`. The provider does not offer inline row edit.

The module's `export` field writes a result export from `STANDARD_DDL_TYPES`, `NOTHING_STANDS_ALONE`, `NO_BARE_SPELLING`, `NULL_NON_FINITE` and `binaryStandardHex`.

## Connection string

[`connection-string.ts`](../../src/lib/db/providers/sql/pipedrive/connection-string.ts) shows no connection string scheme. There is no `readTls`. There is no `paste`. There is no seed load check.

## Execution UI

[`execution-ui.ts`](../../src/lib/db/providers/sql/pipedrive/execution-ui.ts) names `COMMIT` on the rolled-back notice. The consent card has no consent deadline.

## Object edit (#789)

Pipedrive objects are not edited as source from the object tree. No kind declares `hasSource`. The absence is the one `tests/isolated/object-edit-declarations.test.ts` holds for this type-id. No kind declares `acceptsRowWrites` or `acceptsSourceEdits`. The connection is read-only.

## Migration DDL

[`PIPEDRIVE_MIGRATION_DDL`](../../src/lib/db/providers/sql/pipedrive/migration-ddl.ts) declines the whole diff. `refusal` is the one line the migration prints after its header, and `transactionWrapper` is `null`.

The refusal reason it prints, verbatim:

- "Pipedrive object changes are not generated here; this connection is read-only."

## Query

A `SELECT` is `GET /api/v2/<resource>?limit=500`. `deal` reads `/api/v2/deals`, `person` reads `/api/v2/persons`, `organization` reads `/api/v2/organizations`, `activity` reads `/api/v2/activities`, `product` reads `/api/v2/products`, `pipeline` reads `/api/v2/pipelines` and `stage` reads `/api/v2/stages`. `SELECT` of named columns returns those columns. `SELECT *` returns the columns this connection lists for that resource. A numeric id is kept as the API sent it, often a number, and a nested value is JSON. A `LIMIT` above 500 warns that the read is 500. An `OFFSET` past 500 returns no rows and a warning, and it does not call the API. An answer whose `success` is false is a failed read. Generate Query omits `WHERE 1=1` (`supportsConstantPredicate` is false). `EXPLAIN` is not offered (`supportsExplain` is false). There is no maintenance operation. There is no agent language pack: `AGENT_STATEMENT_LANGUAGE` is null for this type-id, and MCP stays closed.
