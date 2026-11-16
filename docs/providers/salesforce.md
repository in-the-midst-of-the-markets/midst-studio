# Salesforce Provider

Salesforce is its own connection type. Studio reaches one org over the REST API (`https://<My Domain>.my.salesforce.com`). It is not a SQL server, and the rows are not copied into another database. The editor still runs SQL: one `SELECT` or `COUNT(*)` is translated into SOQL before anything is sent. This connection does not write.

The connection is an access token in the password field and the org's My Domain in the host field. The token is sent only to a host under `salesforce.com`, over HTTPS, and a redirect is not followed. The dialog has no TLS panel and no SSH tunnel. A live org was not measured; the provider was written against a scripted HTTP client.

The object tree lists Account, Contact, Lead, Opportunity and Case. A statement can name another object by its API name, including a custom object. Columns come from `GET /services/data/v59.0/sobjects/{object}/describe`. `Id` is the record id.

## SQL grammar

[`src/lib/db/providers/sql/salesforce/sql-grammar.ts`](../../src/lib/db/providers/sql/salesforce/sql-grammar.ts) declares `SALESFORCE_GRAMMAR`. `readsSqlText` is `true`. Redaction is `sql` with `"` as its name quote.

Comments are `--` and `/* */`. `#` is code. `//` is not a comment. Names are double-quoted. Format uses sql-formatter's MySQL language (the grammar's `formatterLanguage`).

The editor offers only the words this subset runs (`completionWords` with `lists: "only"`): `SELECT`, `FROM`, `WHERE`, `AND`, `OR`, `ORDER BY`, `ASC`, `DESC`, `LIMIT`, `OFFSET`, `LIKE`, `IS NULL`, `IS NOT NULL` and `COUNT`. It does not offer `INSERT`, `UPDATE`, `DELETE`, `JOIN` or the shared function list. The `SELECT` and `COUNT` snippets are statements this connection can run.

What the provider actually runs is the subset, and a statement outside it fails before a request:

- `SELECT` columns or `*` from one object, with `WHERE` (`=`, `!=`, `<>`, `>`, `>=`, `<`, `<=`, `AND` or `OR` but not both, `IS NULL`, `IS NOT NULL`, and `LIKE`), `ORDER BY`, `LIMIT` and `OFFSET`.
- `COUNT(*)` from one object, with the same `WHERE`.

`SELECT *` sends `Id` and up to 20 other fields from the describe. A join, a write, `GROUP BY`, `WITH`, `DISTINCT`, a relationship field, and a parameter list are refused. One statement reads at most 2000 rows. A further page on another host is refused.

## SQL writing

[`salesforce/sql-writing.ts`](../../src/lib/db/providers/sql/salesforce/sql-writing.ts) declares how a generated statement spells a literal, a name and a bind, and it is this engine's row of `SQL_WRITING`.

A literal is written by `literalStandard` and read back by `unquoteStandard`. A name is quoted by `identifierDoubleQuoted`. There is no placeholder: the query API does not bind parameters, and `query()` refuses a parameter list.

`inlineEdit` uses `INSTANT_TYPE_NAMES`, `FLOAT64_TYPE_NAMES` and `EXACT_DECIMAL_TYPE_NAMES`. The provider does not offer inline row edit.

The module's `export` field writes a result export from `STANDARD_DDL_TYPES`, `NOTHING_STANDS_ALONE`, `NO_BARE_SPELLING`, `NULL_NON_FINITE` and `binaryStandardHex`.

## Connection string

[`connection-string.ts`](../../src/lib/db/providers/sql/salesforce/connection-string.ts) shows no connection string scheme. There is no `readTls`. There is no `paste`. There is no seed load check.

## Execution UI

[`execution-ui.ts`](../../src/lib/db/providers/sql/salesforce/execution-ui.ts) names `COMMIT` on the rolled-back notice. The consent card has no consent deadline.

## Object edit (#789)

Salesforce objects are not edited as source from the object tree. No kind declares `hasSource`. The absence is the one `tests/isolated/object-edit-declarations.test.ts` holds for this type-id.

## Migration DDL

[`SALESFORCE_MIGRATION_DDL`](../../src/lib/db/providers/sql/salesforce/migration-ddl.ts) declines the whole diff. `refusal` is the one line the migration prints after its header, and `transactionWrapper` is `null`.

The refusal reason it prints, verbatim:

- "Salesforce object changes are not generated here; create the field in Salesforce."

## Query

`SELECT` paging is `LIMIT n` and `OFFSET n` in the SOQL. The query resource is `GET /services/data/v59.0/query`. A `nextRecordsUrl` is followed only when it stays on the same host and under `/services/data/`, at most four pages.

`COUNT(*)` is sent as `SELECT COUNT()`. Generate Query omits `WHERE 1=1` (`supportsConstantPredicate` is false).

`EXPLAIN` is not offered (`supportsExplain` is false). There is no maintenance operation.
