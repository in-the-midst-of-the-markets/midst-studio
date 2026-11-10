# Notion Provider

Notion is its own connection type. Studio reaches the databases an integration was invited to over the API (`https://api.notion.com`, `Notion-Version: 2026-03-11`). It is not a SQL server. The editor still runs SQL: one `SELECT` or `COUNT(*)` is translated into a data-source query before anything is sent. A page body is not requested. The rows are not copied into another database. A write is refused before a request. The connection is read-only.

The connection is an internal integration token in the password field. The API host defaults to `api.notion.com` and nothing else is accepted. The token is sent only there, over HTTPS, as `Authorization: Bearer`, and a redirect is not followed. The dialog has no TLS panel and no SSH tunnel. A database appears in the object tree only after it has been shared with the integration. Until then the tree is empty and the token still connects.

The object tree is one workspace and the data sources `POST /v1/search` returns for `object` `data_source`. A database title is the table name. Two data sources with one title are named with the first eight characters of the id. A data source in the trash is left out. Properties are the columns, and every row also carries `_id`, the page id.

## SQL grammar

[`src/lib/db/providers/sql/notion/sql-grammar.ts`](../../src/lib/db/providers/sql/notion/sql-grammar.ts) declares `NOTION_GRAMMAR`. `readsSqlText` is `true`. Redaction is `sql` with `"` as its name quote.

Comments are `--` and `/* */`. `#` is code. `//` is not a comment. Names are double-quoted. Format uses sql-formatter's MySQL language (the grammar's `formatterLanguage`).

The editor completes `SELECT`, `FROM`, `WHERE`, `AND`, `OR`, `NOT`, `ORDER BY`, `ASC`, `DESC`, `LIMIT`, `OFFSET`, `COUNT`, `LIKE`, `IS` and `NULL` (the grammar's `completionWords`, with `lists: "only"`). A property whose name has a space is completed in quotes, which is the form the statement runs. `SELECT` and `COUNT` are snippets.

What the provider actually runs is narrower than the highlighter, and a statement outside it fails before a request:

- `SELECT` columns or `*` from one database, with `WHERE` (`=`, `!=`, `<>`, `>`, `>=`, `<`, `<=`, `AND`, `OR`, `NOT`, parentheses, `IS NULL`, `IS NOT NULL`, and `LIKE` as a prefix, a suffix, or a contains), `ORDER BY`, `LIMIT` and `OFFSET`.
- `COUNT(*)` from one database, with the same `WHERE`. It counts the rows the same 1000-row read would return.

A join, any other aggregate, `WITH`, `DISTINCT`, `IN`, `BETWEEN`, `INSERT`, `UPDATE`, `DELETE` and a parameter list are refused with a sentence that says what to write instead. One statement reads at most 1000 rows. Notion allows about three requests a second; a statement that is refused for rate comes back as a query error that says to wait.

A filter follows the property type. Text uses equals and contains. A number, a unique id and a date use comparisons. A checkbox, a select and a status use equals. A person and a relation are matched by id. `created_time` and `last_edited_time` use Notion's timestamp filter. A formula, a rollup and a file are not filtered. Notion nests a filter two levels deep, and a deeper `WHERE` is refused.

## SQL writing

[`notion/sql-writing.ts`](../../src/lib/db/providers/sql/notion/sql-writing.ts) declares how a generated statement spells a literal, a name and a bind, and it is this engine's row of `SQL_WRITING`.

A literal is written by `literalStandard` and read back by `unquoteStandard`. A name is quoted by `identifierDoubleQuoted`. There is no placeholder: the API does not bind parameters, and `query()` refuses a parameter list.

`inlineEdit` uses `INSTANT_TYPE_NAMES`, `FLOAT64_TYPE_NAMES` and `EXACT_DECIMAL_TYPE_NAMES`. The provider does not offer inline row edit.

The module's `export` field writes a result export from `STANDARD_DDL_TYPES`, `NOTHING_STANDS_ALONE`, `NO_BARE_SPELLING`, `NULL_NON_FINITE` and `binaryStandardHex`.

## Connection string

[`connection-string.ts`](../../src/lib/db/providers/sql/notion/connection-string.ts) shows no connection string scheme. There is no `readTls`. There is no `paste`. There is no seed load check.

## Execution UI

[`execution-ui.ts`](../../src/lib/db/providers/sql/notion/execution-ui.ts) names `COMMIT` on the rolled-back notice. The consent card has no consent deadline.

## Object edit (#789)

Notion databases are not edited as source from the object tree. No kind declares `hasSource`. The absence is the one `tests/isolated/object-edit-declarations.test.ts` holds for this type-id. No kind declares `acceptsRowWrites` or `acceptsSourceEdits`. The connection is read-only.

## Migration DDL

[`NOTION_MIGRATION_DDL`](../../src/lib/db/providers/sql/notion/migration-ddl.ts) declines the whole diff. `refusal` is the one line the migration prints after its header, and `transactionWrapper` is `null`.

The refusal reason it prints, verbatim:

- "Notion object changes are not generated here; this connection is read-only."

## Query

The catalog is `POST /v1/search` with `filter.property` `object` and `filter.value` `data_source`, paged by `start_cursor`. A query is `POST /v1/data_sources/{id}/query` with `filter`, `sorts` and `page_size` of at most 100. The provider walks `next_cursor` until the `LIMIT` and `OFFSET` are filled or 1000 rows have been read. A cell is the property's scalar: rich text is joined, a select is its name, people and relations are names or page ids, and a rollup is its number, date or text. Generate Query omits `WHERE 1=1` (`supportsConstantPredicate` is false). `EXPLAIN` is not offered (`supportsExplain` is false). There is no maintenance operation. There is no agent language pack: `AGENT_STATEMENT_LANGUAGE` is null for this type-id, and MCP stays closed.
