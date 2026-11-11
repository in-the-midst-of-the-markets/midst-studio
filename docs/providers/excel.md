# Microsoft Excel Provider

Microsoft Excel is its own connection type. Studio reaches one workbook on Microsoft Graph (`https://graph.microsoft.com`). It is not a SQL server. The editor still runs SQL: one `SELECT` is one worksheet, and the filter, the order and the page are applied to the cells Studio read. A write is refused before a request. The rows are not copied into another database. The connection is read-only. Cells past column Z, and rows past 500, are not requested.

The workbook path is `/drives/<drive id>/items/<item id>`. The password is an access token, or a client secret. A client secret also needs the application (client) id and the directory (tenant) id. The secret is sent only to `login.microsoftonline.com`. The access token is sent only to `graph.microsoft.com`, over TLS, on the shared HTTP transport. Studio does not put the secret in a URL. Any other path is refused, and the refusal does not repeat the path or the secret. A redirect is not followed. Studio refreshes a client-secret token until it expires. A pasted access token is not refreshed. The dialog has no TLS panel and no SSH tunnel.

The object tree is one workbook and up to 20 worksheets that are not hidden. A worksheet named `Sheet1` is the table `sheet1`. A name with a space, such as `Q1 Sales`, is `q1_sales`. A name that does not start with a letter takes `sheet` and its place in the list. The first row of `A1:Z501` names the fields the same way. A blank header becomes `column_` and its place.

## SQL grammar

[`src/lib/db/providers/sql/excel/sql-grammar.ts`](../../src/lib/db/providers/sql/excel/sql-grammar.ts) declares `EXCEL_SQL_GRAMMAR`, whose `grammar` is `EXCEL_GRAMMAR`. `readsSqlText` is `true`. Redaction is `sql` with `"` as its name quote.

Comments are `--` and `/* */`. `#` is code. `//` is not a comment. Names are double-quoted. Format uses sql-formatter's MySQL language (the grammar's `formatterLanguage`).

The editor offers only the words this subset runs (`completionWords` with `lists: "only"`): `SELECT`, `FROM`, `WHERE`, `AND`, `ORDER BY`, `ASC`, `DESC`, `LIMIT`, `OFFSET`, `LIKE`, `IS NULL` and `IS NOT NULL`. It does not offer `INSERT`, `UPDATE`, `DELETE`, `JOIN`, `COUNT` or the shared function list. A field whose name contains a dot is completed as that one word. The `SELECT` snippet is a statement this connection can run.

What the provider actually runs is the subset, and a statement outside it fails before a request:

- `SELECT` columns or `*` from one worksheet, such as `sheet1`. A field is the header, folded into one word, such as `name` or `amount`.
- `WHERE` comparisons (`=`, `!=`, `<>`, `<`, `>`, `<=`, `>=`), `LIKE`, `IS NULL` and `IS NOT NULL`. `AND` only. Every value is quoted, because the cells are the text Excel shows.
- `ORDER BY` one field. A null sorts last.
- `LIMIT` and `OFFSET`, capped at 500 rows. The default limit is 100. Studio keeps the page locally. An `OFFSET` of 500 or more returns no rows and does not call the API.

`COUNT(*)`, `OR`, a join, `IN`, `DISTINCT`, a second statement, and a parameter list are refused.

## SQL writing

[`excel/sql-writing.ts`](../../src/lib/db/providers/sql/excel/sql-writing.ts) declares how a generated statement spells a literal, a name and a bind, and it is this engine's row of `SQL_WRITING`.

A literal is written by `literalStandard` and read back by `unquoteStandard`. A name is quoted by `identifierDoubleQuoted`. There is no placeholder: the API does not bind parameters, and `query()` refuses a parameter list.

`inlineEdit` uses `INSTANT_TYPE_NAMES`, `FLOAT64_TYPE_NAMES` and `EXACT_DECIMAL_TYPE_NAMES`. The provider does not offer inline row edit.

The module's `export` field writes a result export from `STANDARD_DDL_TYPES`, `NOTHING_STANDS_ALONE`, `NO_BARE_SPELLING`, `NULL_NON_FINITE` and `binaryStandardHex`.

## Connection string

[`connection-string.ts`](../../src/lib/db/providers/sql/excel/connection-string.ts) shows no connection string scheme. There is no `readTls`. There is no `paste`. There is no seed load check.

## Execution UI

[`execution-ui.ts`](../../src/lib/db/providers/sql/excel/execution-ui.ts) names `COMMIT` on the rolled-back notice. The consent card has no consent deadline.

## Object edit (#789)

Microsoft Excel objects are not edited as source from the object tree. No kind declares `hasSource`. The absence is the one `tests/isolated/object-edit-declarations.test.ts` holds for this type-id. No kind declares `acceptsRowWrites` or `acceptsSourceEdits`. The connection is read-only.

## Migration DDL

[`EXCEL_MIGRATION_DDL`](../../src/lib/db/providers/sql/excel/migration-ddl.ts) declines the whole diff. `refusal` is the one line the migration prints after its header, and `transactionWrapper` is `null`.

The refusal reason it prints, verbatim:

- "Microsoft Excel object changes are not generated here; this connection is read-only."

## Query

Connect exchanges a client secret, or uses a pasted access token, and then reads the worksheet list. It does not read a range.

A `SELECT` is `GET /drives/<drive id>/items/<item id>/workbook/worksheets/<id>/range(address='A1:Z501')` with `$select=text`. The first row is the header. A hidden worksheet is not a table. At most 20 worksheets are listed. `SELECT` of named columns returns those columns. `SELECT *` returns the columns of that header. A `LIMIT` above 500 warns that the read is one page. A range that fills all 500 rows, or all 26 columns, warns the same way, and the next page is not requested. An `OFFSET` past 500 returns no rows and a warning, and it does not call the API. Generate Query omits `WHERE 1=1` (`supportsConstantPredicate` is false). `EXPLAIN` is not offered (`supportsExplain` is false). There is no maintenance operation. There is no agent language pack: `AGENT_STATEMENT_LANGUAGE` is null for this type-id, and MCP stays closed.
