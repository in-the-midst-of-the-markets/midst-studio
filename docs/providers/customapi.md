# Custom API

A connection the user defines for an HTTPS API this app does not already ship. One SELECT reads one GET path they named. The secret is sent only to the hostname they saved, as a header, and never in the URL.

## Connection

| Field | Role |
| --- | --- |
| Hostname | A public hostname, such as `api.example.com`. `https://` may be pasted and is removed. Plain HTTP, an IP address, and a private or link-local name are refused. A name that resolves to a private, loopback, or link-local address is refused too. |
| Secret | At least 8 characters, with no newline. Bearer sends `Authorization: Bearer`. Basic sends `Authorization: Basic` of the username and the secret. A header sends the secret under the header name they chose. |
| Resource list | Stored on the connection as `apiCatalog`. Each resource has a name, a path that starts with `/`, and an optional rows path such as `data`. |

The connection dialog writes the list. It is a JSON document: `auth` is `bearer`, `header`, or `basic`, and each resource has a `name`, a `path`, and a `rows` path. A header also names `headerName`. The secret is not part of the document.

## SQL grammar

[`src/lib/db/providers/sql/customapi/sql-grammar.ts`](../../src/lib/db/providers/sql/customapi/sql-grammar.ts) declares `CUSTOMAPI_SQL_GRAMMAR`, whose `grammar` is `REST_GRAMMAR`. `readsSqlText` is `true`. Redaction is `sql` with `"` as its name quote.

Comments are `--` and `/* */`. `#` is code. `//` is not a comment. Names are double-quoted. Format uses sql-formatter's MySQL language (the grammar's `formatterLanguage`).

The editor offers only the words this subset runs (`completionWords` with `lists: "only"`): `SELECT`, `FROM`, `WHERE`, `AND`, `ORDER BY`, `ASC`, `DESC`, `LIMIT`, `OFFSET`, `LIKE`, `IS NULL` and `IS NOT NULL`. It does not offer `INSERT`, `UPDATE`, `DELETE`, `JOIN`, `COUNT` or the shared function list. A field whose name contains a dot is completed as that one word. The `SELECT` snippet is a statement this connection can run.

What the provider actually runs is the subset, and a statement outside it fails before a request:

- `SELECT` columns or `*` from one named resource, such as `items`.
- `WHERE` comparisons (`=`, `!=`, `<>`, `<`, `>`, `<=`, `>=`), `LIKE`, `IS NULL` and `IS NOT NULL`. `AND` only. Text values are quoted. A number is unquoted.
- `ORDER BY` one field.
- `LIMIT` and `OFFSET`, capped at 200 rows.

`COUNT(*)`, `OR`, a join, `IN`, `DISTINCT`, a second statement, and a parameter list are refused.

## SQL writing

[`customapi/sql-writing.ts`](../../src/lib/db/providers/sql/customapi/sql-writing.ts) declares how a generated statement spells a literal, a name and a bind, and it is this engine's row of `SQL_WRITING`.

A literal is written by `literalStandard` and read back by `unquoteStandard`. A name is quoted by `identifierDoubleQuoted`. There is no placeholder: the API does not bind parameters, and `query()` refuses a parameter list.

`inlineEdit` uses `INSTANT_TYPE_NAMES`, `FLOAT64_TYPE_NAMES` and `EXACT_DECIMAL_TYPE_NAMES`. The provider does not offer inline row edit.

The module's `export` field writes a result export from `STANDARD_DDL_TYPES`, `NOTHING_STANDS_ALONE`, `NO_BARE_SPELLING`, `NULL_NON_FINITE` and `binaryStandardHex`.

## Connection string

[`connection-string.ts`](../../src/lib/db/providers/sql/customapi/connection-string.ts) shows no connection string scheme. There is no `readTls`. There is no `paste`. There is no seed load check. `apiCatalog` is the resource list, and a seed of any other type that carries it is refused.

## Execution UI

[`execution-ui.ts`](../../src/lib/db/providers/sql/customapi/execution-ui.ts) names `COMMIT` on the rolled-back notice. The consent card has no consent deadline.

## Object edit (#789)

Custom API objects are not edited as source from the object tree. No kind declares `hasSource`. The absence is the one `tests/isolated/object-edit-declarations.test.ts` holds for this type-id. No kind declares `acceptsRowWrites` or `acceptsSourceEdits`. The connection is read-only.

## Migration DDL

[`CUSTOMAPI_MIGRATION_DDL`](../../src/lib/db/providers/sql/customapi/migration-ddl.ts) declines the whole diff. `refusal` is the one line the migration prints after its header, and `transactionWrapper` is `null`.

The refusal reason it prints, verbatim:

- "Custom API object changes are not generated here; this connection is read-only."

## Query

One read-only SELECT of one resource. `WHERE`, `ORDER BY`, `LIMIT` and `OFFSET` are applied to that answer. Writes, joins, and `COUNT` are refused before a request. At most 200 rows are read. A redirect is not followed.

`SELECT * FROM items` returns the fields of each JSON object. `SELECT id FROM items WHERE id = '1'` returns that field. A rows path of `data.items` reads that array. An empty rows path expects the body itself to be an array.

## What this connection does not do

It does not call an arbitrary URL. The path is a relative path on the saved hostname. It does not send the secret to any other host, and it does not follow a redirect. It does not open a private, loopback, or link-local address, including when a public-looking name resolves to one. Agent mode does not write statements for it.
