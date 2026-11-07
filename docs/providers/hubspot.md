# HubSpot Provider

HubSpot is its own connection type. Studio reaches a CRM account over the Web API (`https://api.hubapi.com`). It is not a SQL server, and the rows are not copied into another database. The editor still runs SQL: one `SELECT`, `INSERT`, `UPDATE`, or `DELETE` is translated into that API before anything is sent.

The connection is a private app token in the password field. The API host defaults to `api.hubapi.com`. The token is sent only to a host under `hubapi.com`, over HTTPS, and a redirect is not followed. The dialog has no TLS panel and no SSH tunnel.

The object tree is the standard CRM objects: contacts, companies, deals, tickets, products, line items, and quotes. Columns come from `GET /crm/v3/properties/{object}`. The `id` column is the record id.

## SQL grammar

[`src/lib/db/providers/sql/hubspot/sql-grammar.ts`](../../src/lib/db/providers/sql/hubspot/sql-grammar.ts) declares `HUBSPOT_GRAMMAR`. `readsSqlText` is `true`. Redaction is `sql` with `"` as its name quote.

Comments are `--` and `/* */`. `#` is code. `//` is not a comment. Names are double-quoted. Format uses sql-formatter's MySQL language (the grammar's `formatterLanguage`).

The editor offers only the words this subset runs (`completionWords` with `lists: "only"`): `SELECT`, `INSERT INTO`, `UPDATE`, `DELETE FROM`, `WHERE`, `ORDER BY`, `LIMIT`, `OFFSET`, `LIKE` and `COUNT`. It does not offer `JOIN`, `GROUP BY` or the shared function list. `SELECT`, `COUNT`, `INSERT`, `UPDATE` and `DELETE` are snippets, and each one is a statement this connection can run. Generate Query names the columns when there are at most eight, and writes `SELECT *` under a comment when the object has more properties than that.

What the provider actually runs is narrower than the highlighter, and a statement outside it fails before a request:

- `SELECT` columns or `*` from one object, with `WHERE` (`=`, `!=`, `<>`, `>`, `>=`, `<`, `<=`, `AND`, `OR`, `IS NULL`, `IS NOT NULL`, and `LIKE` as a prefix, a suffix, or a contains), `ORDER BY`, `LIMIT` and `OFFSET`.
- `INSERT INTO` one object, at most 10 rows.
- `UPDATE` one object `SET` columns `WHERE id = '123'`.
- `DELETE FROM` one object `WHERE id = '123'`.

`COUNT(*)` is the one aggregate. HubSpot's search reports at most 10000 matches, and a larger match set is warned about. A join, any other aggregate, `WITH`, `DISTINCT`, `IN`, `BETWEEN`, `NOT`, and a parameter list are refused with a sentence that says what to write instead. A result always includes `id`. One statement reads at most 1000 rows.

## SQL writing

[`hubspot/sql-writing.ts`](../../src/lib/db/providers/sql/hubspot/sql-writing.ts) declares how a generated statement spells a literal, a name and a bind, and it is this engine's row of `SQL_WRITING`.

A literal is written by `literalStandard` and read back by `unquoteStandard`. A name is quoted by `identifierDoubleQuoted`. There is no placeholder: the Web API does not bind parameters, and `query()` refuses a parameter list.

`inlineEdit` uses `INSTANT_TYPE_NAMES`, `FLOAT64_TYPE_NAMES` and `EXACT_DECIMAL_TYPE_NAMES`. The provider does not offer inline row edit.

The module's `export` field writes a result export from `STANDARD_DDL_TYPES`, `NOTHING_STANDS_ALONE`, `NO_BARE_SPELLING`, `NULL_NON_FINITE` and `binaryStandardHex`.

## Connection string

[`connection-string.ts`](../../src/lib/db/providers/sql/hubspot/connection-string.ts) shows no connection string scheme. There is no `readTls`. There is no `paste`. There is no seed load check.

## Execution UI

[`execution-ui.ts`](../../src/lib/db/providers/sql/hubspot/execution-ui.ts) names `COMMIT` on the rolled-back notice. The consent card has no consent deadline.

## Object edit (#789)

HubSpot objects are not edited as source from the object tree. No kind declares `hasSource`. The absence is the one `tests/isolated/object-edit-declarations.test.ts` holds for this type-id.

## Migration DDL

[`HUBSPOT_MIGRATION_DDL`](../../src/lib/db/providers/sql/hubspot/migration-ddl.ts) declines the whole diff. `refusal` is the one line the migration prints after its header, and `transactionWrapper` is `null`.

The refusal reason it prints, verbatim:

- "HubSpot property changes are not generated here; create the property in HubSpot."

## Query

`SELECT` paging is `LIMIT n` and `LIMIT n OFFSET m`. The shared limiter appends the page bound, and the provider reads that bound by walking HubSpot's search cursor. Offset is a number of rows, not the opaque `after` cursor. Pages are 100 records.

`INSERT` sends one batch create. `UPDATE` and `DELETE` address one record by `id`. A read-only connection refuses those writes and still runs `SELECT` and `COUNT(*)`. Generate Query omits `WHERE 1=1` (`supportsConstantPredicate` is false), because that predicate is not a property comparison the translator can send.

`EXPLAIN` is not offered (`supportsExplain` is false). There is no maintenance operation.
