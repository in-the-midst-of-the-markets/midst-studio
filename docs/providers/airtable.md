# Airtable Provider

Airtable is its own connection type. Studio reaches a base over the Web API (`https://api.airtable.com`). It is not a SQL server. The editor still runs SQL: one `SELECT`, `INSERT`, `UPDATE`, or `DELETE` is translated into that API before anything is sent.

The connection is an access token in the password field and a base id (the `app…` segment of the Airtable URL) in the database field. The API host defaults to `api.airtable.com`. The token is sent only to a host under `airtable.com`, over HTTPS, and a redirect is not followed. The dialog has no TLS panel.

The object tree is the base's tables, from `GET /v0/meta/bases/{baseId}/tables`. The token needs schema access for that call and data access for the records.

## SQL grammar

[`src/lib/db/providers/sql/airtable/sql-grammar.ts`](../../src/lib/db/providers/sql/airtable/sql-grammar.ts) declares `AIRTABLE_GRAMMAR`. `readsSqlText` is `true`. Redaction is `sql` with `"` as its name quote.

Comments are `--` and `/* */`. `#` is code. `//` is not a comment. Names are double-quoted. Format uses sql-formatter's MySQL language (the grammar's `formatterLanguage`).

The editor completes `SELECT`, `INSERT INTO`, `UPDATE`, `DELETE FROM`, `WHERE`, `ORDER BY`, `LIMIT` and `OFFSET` beside the shared SQL lists (the grammar's `completionWords`). `SELECT`, `INSERT`, `UPDATE` and `DELETE` are also snippets.

What the provider actually runs is narrower than the highlighter, and a statement outside it fails before a request:

- `SELECT` columns or `*` from one table, with `WHERE` (`=`, `!=`, `<>`, `>`, `>=`, `<`, `<=`, `AND`, `OR`, `NOT`, parentheses, `IS NULL`, `IS NOT NULL`, and `LIKE` as a prefix, a suffix, or a contains), `ORDER BY`, `LIMIT` and `OFFSET`.
- `INSERT INTO` one table, at most 10 rows.
- `UPDATE` one table `SET` columns `WHERE _id = 'rec…'`.
- `DELETE FROM` one table `WHERE _id = 'rec…'`.

`COUNT(*)` is the one aggregate, and it counts the rows the same 1000-row read would return. A join, any other aggregate, `WITH`, `DISTINCT`, `IN`, `BETWEEN` and a parameter list are refused with a sentence that says what to write instead. A result always includes `_id`, the Airtable record id. One statement reads at most 1000 rows.

## SQL writing

[`airtable/sql-writing.ts`](../../src/lib/db/providers/sql/airtable/sql-writing.ts) declares how a generated statement spells a literal, a name and a bind, and it is this engine's row of `SQL_WRITING`.

A literal is written by `literalStandard` and read back by `unquoteStandard`. A name is quoted by `identifierDoubleQuoted`. There is no placeholder: the Web API does not bind parameters, and `query()` refuses a parameter list.

`inlineEdit` uses `INSTANT_TYPE_NAMES`, `FLOAT64_TYPE_NAMES` and `EXACT_DECIMAL_TYPE_NAMES`. The provider does not offer inline row edit.

The module's `export` field writes a result export from `STANDARD_DDL_TYPES`, `NOTHING_STANDS_ALONE`, `NO_BARE_SPELLING`, `NULL_NON_FINITE` and `binaryStandardHex`.

## Connection string

[`connection-string.ts`](../../src/lib/db/providers/sql/airtable/connection-string.ts) shows no connection string scheme. There is no `readTls`. There is no `paste`. There is no seed load check.

## Execution UI

[`execution-ui.ts`](../../src/lib/db/providers/sql/airtable/execution-ui.ts) names `COMMIT` on the rolled-back notice. The consent card has no consent deadline.

## Object edit (#789)

Airtable tables are not edited as source from the object tree. No kind declares `hasSource`. The absence is the one `tests/isolated/object-edit-declarations.test.ts` holds for this type-id.

## Migration DDL

[`AIRTABLE_MIGRATION_DDL`](../../src/lib/db/providers/sql/airtable/migration-ddl.ts) declines the whole diff. `refusal` is the one line the migration prints after its header, and `transactionWrapper` is `null`.

The refusal reason it prints, verbatim:

- "Airtable table changes are not generated here; create the field in Airtable."

## Query

`SELECT` paging is `LIMIT n` and `LIMIT n OFFSET m`. The shared limiter appends the page bound, and the provider reads that bound as `maxRecords` plus the rows it skips. Offset is a number of rows, not Airtable's opaque cursor. The cursor is used internally to walk pages of 100.

`INSERT`, `UPDATE` and `DELETE` send one request with `typecast: true`. An update or a delete that is not addressed by `_id` is refused. A read-only connection refuses those writes and still runs `SELECT` and `COUNT(*)`. Generate Query omits `WHERE 1=1` (`supportsConstantPredicate` is false), because that predicate is not a field comparison the translator can send.

`EXPLAIN` is not offered (`supportsExplain` is false). There is no maintenance operation.
