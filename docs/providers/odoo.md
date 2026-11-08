# Odoo Provider

Odoo Online is its own connection type. Studio reaches a database over the JSON-2 API (`https://mycompany.odoo.com`). It is not a SQL server, and the rows are not copied into another database. The editor still runs SQL: one `SELECT` or `COUNT(*)` is one query. A write is refused before a request. The connection is read-only.

The connection is an API key in the password field and a host under `odoo.com`, such as `mycompany.odoo.com`. The key is created in Preferences, Account Security, and it lasts at most three months. Studio does not refresh it. The key is sent only to that host, over TLS, on the shared HTTP transport. That path does not use global fetch, so a proxy setting cannot carry the key. A host that does not end in `odoo.com` is refused, and the refusal does not repeat the host or the key. A redirect is not followed. The dialog has no TLS panel and no SSH tunnel. The host selects the database, so the request does not send `X-Odoo-Database`.

The object tree is one database and the models `ir.model` returns, skipping transient models. The tree is one page of 200 models, ordered by technical name. A model past that page can still be queried when its name is written in the statement. A field list is one page of 200 fields. A query page is at most 200 rows. When `LIMIT` is omitted the page is 100.

External API access on Odoo Online is a Custom plan feature. This connection uses JSON-2, which Odoo documents from version 19. It does not use XML-RPC.

## SQL grammar

[`src/lib/db/providers/sql/odoo/sql-grammar.ts`](../../src/lib/db/providers/sql/odoo/sql-grammar.ts) declares `ODOO_GRAMMAR`. `readsSqlText` is `true`. Redaction is `sql` with `"` as its name quote.

Comments are `--` and `/* */`. `#` is code. `//` is not a comment. Names are double-quoted. Format uses sql-formatter's MySQL language (the grammar's `formatterLanguage`).

The editor offers only the words this subset runs (`completionWords` with `lists: "only"`): `SELECT`, `FROM`, `WHERE`, `AND`, `ORDER BY`, `ASC`, `DESC`, `LIMIT`, `OFFSET`, `COUNT`, `LIKE`, `ILIKE` and `IN`. It does not offer `INSERT`, `UPDATE`, `DELETE`, `JOIN`, `OR` or the shared function list. `SELECT` and `COUNT` are snippets, and each one is a statement this connection can run. Generate Query names the columns when there are at most eight, and writes `SELECT *` under a comment when the table has more fields than that.

What the provider actually runs is the subset, and a statement outside it fails before a request:

- `SELECT` columns or `*` from one model, such as `res.partner`. A dotted field such as `partner_id.name` is one name.
- `WHERE` equalities and comparisons (`=`, `!=`, `<`, `>`, `<=`, `>=`), `LIKE`, `ILIKE`, and `IN` of quoted values, numbers, or `true` and `false`. `AND` only.
- `ORDER BY` one field. The request spells that as Odoo's `order` string.
- `LIMIT` is capped at 200. `OFFSET` is 0-based and is sent as `offset`.
- `COUNT(*)` is `search_count`. It does not take `ORDER BY` or `LIMIT`. An alias is the column name; without one the column is `count`.

`OR`, a join, a second statement, and a parameter list are refused.

## SQL writing

[`odoo/sql-writing.ts`](../../src/lib/db/providers/sql/odoo/sql-writing.ts) declares how a generated statement spells a literal, a name and a bind, and it is this engine's row of `SQL_WRITING`.

A literal is written by `literalStandard` and read back by `unquoteStandard`. A name is quoted by `identifierDoubleQuoted`. There is no placeholder: the API does not bind parameters, and `query()` refuses a parameter list.

`inlineEdit` uses `INSTANT_TYPE_NAMES`, `FLOAT64_TYPE_NAMES` and `EXACT_DECIMAL_TYPE_NAMES`. The provider does not offer inline row edit.

The module's `export` field writes a result export from `STANDARD_DDL_TYPES`, `NOTHING_STANDS_ALONE`, `NO_BARE_SPELLING`, `NULL_NON_FINITE` and `binaryStandardHex`.

## Connection string

[`connection-string.ts`](../../src/lib/db/providers/sql/odoo/connection-string.ts) shows no connection string scheme. There is no `readTls`. There is no `paste`. There is no seed load check.

## Execution UI

[`execution-ui.ts`](../../src/lib/db/providers/sql/odoo/execution-ui.ts) names `COMMIT` on the rolled-back notice. The consent card has no consent deadline.

## Object edit (#789)

Odoo objects are not edited as source from the object tree. No kind declares `hasSource`. The absence is the one `tests/isolated/object-edit-declarations.test.ts` holds for this type-id. No kind declares `acceptsRowWrites` or `acceptsSourceEdits`. The connection is read-only.

## Migration DDL

[`ODOO_MIGRATION_DDL`](../../src/lib/db/providers/sql/odoo/migration-ddl.ts) declines the whole diff. `refusal` is the one line the migration prints after its header, and `transactionWrapper` is `null`.

The refusal reason it prints, verbatim:

- "Odoo object changes are not generated here; this connection is read-only."

## Query

The query is `POST /json/2/{model}/search_read` with a JSON body of `domain`, `fields`, `order`, `limit` and `offset`. `COUNT(*)` is `POST /json/2/{model}/search_count` with `domain`. A many2one value `[id, name]` becomes the id in the field and the display name in `field.name`. JSON `false` stays false. Other arrays become null. Nested objects are flattened with dotted keys. `SELECT` of named columns returns those columns. `SELECT *` returns the flattened keys. A full page warns that the next page needs a larger `LIMIT` or an `OFFSET`. A `LIMIT` above 200 warns that the page is 200.

A connection probe is `POST /json/2/res.users/context_get` with `{}`. The model list is `ir.model` and the field list is `ir.model.fields`.

Generate Query omits `WHERE 1=1` (`supportsConstantPredicate` is false). `EXPLAIN` is not offered (`supportsExplain` is false). There is no maintenance operation. There is no agent language pack: `AGENT_STATEMENT_LANGUAGE` is null for this type-id, and MCP stays closed.
