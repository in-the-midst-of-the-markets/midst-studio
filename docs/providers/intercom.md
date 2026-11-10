# Intercom Provider

Intercom is its own connection type. Studio reaches one workspace over the REST API (`https://api.intercom.io`). It is not a SQL server. The editor still runs SQL: one `SELECT` or `COUNT(*)` is one list or one search. A write is refused before a request. The rows are not copied into another database. The connection is read-only.

The connection is an access token in the password field. The token lasts until it is revoked. Studio does not refresh it. The API host is `api.intercom.io`, `api.eu.intercom.io`, or `api.au.intercom.io`. An empty host uses `api.intercom.io`. The token is sent only there, over TLS, on the shared HTTP transport, with `Intercom-Version: 2.17`. That path does not use global fetch, so a proxy setting cannot carry the token. Any other host is refused, and the refusal does not repeat the host or the token. A redirect is not followed. The dialog has no TLS panel and no SSH tunnel.

The object tree is one workspace and the lists this connection shows: contacts, conversations, admins, tags, segments, and teams. Companies stay out: the company list asks for a write scope. Articles, tickets, and events stay out. A cursor page is 50 rows. One statement stops at 1000 rows.

## SQL grammar

[`src/lib/db/providers/sql/intercom/sql-grammar.ts`](../../src/lib/db/providers/sql/intercom/sql-grammar.ts) declares `INTERCOM_GRAMMAR`. `readsSqlText` is `true`. Redaction is `sql` with `"` as its name quote.

Comments are `--` and `/* */`. `#` is code. `//` is not a comment. Names are double-quoted. Format uses sql-formatter's MySQL language (the grammar's `formatterLanguage`).

The editor offers only the words this subset runs (`completionWords` with `lists: "only"`): `SELECT`, `FROM`, `WHERE`, `AND`, `ORDER BY`, `ASC`, `DESC`, `LIMIT`, `OFFSET`, `COUNT` and `LIKE`. It does not offer `INSERT`, `UPDATE`, `DELETE`, `JOIN` or the shared function list. `SELECT` and `COUNT` are snippets, and each one is a statement this connection can run.

What the provider actually runs is the subset, and a statement outside it fails before a request:

- `SELECT` columns or `*` from one listed endpoint, such as `Contacts` or `Conversations`. A dotted field such as `source.type` is one name.
- `WHERE` comparisons (`=`, `!=`, `<>`, `<`, `>`, `<=`, `>=`) and `LIKE`. `AND` only. Text `LIKE` is a prefix (`abc%`), a suffix (`%abc`), or a contains (`%abc%`). A date is `YYYY-MM-DD`, sent as a Unix time. A time field also accepts a number.
- `ORDER BY` one field. Intercom's list has no general sort, so the order is applied to the rows this statement read, at most 1000.
- `LIMIT` and `OFFSET`, capped at 1000 rows.
- `COUNT(*)` counts the same filtered list. A cursor list uses `total_count` when Intercom sends it.

`OR`, a join, `IN`, `DISTINCT`, a second statement, and a parameter list are refused.

## SQL writing

[`intercom/sql-writing.ts`](../../src/lib/db/providers/sql/intercom/sql-writing.ts) declares how a generated statement spells a literal, a name and a bind, and it is this engine's row of `SQL_WRITING`.

A literal is written by `literalStandard` and read back by `unquoteStandard`. A name is quoted by `identifierDoubleQuoted`. There is no placeholder: the API does not bind parameters, and `query()` refuses a parameter list.

`inlineEdit` uses `INSTANT_TYPE_NAMES`, `FLOAT64_TYPE_NAMES` and `EXACT_DECIMAL_TYPE_NAMES`. The provider does not offer inline row edit.

The module's `export` field writes a result export from `STANDARD_DDL_TYPES`, `NOTHING_STANDS_ALONE`, `NO_BARE_SPELLING`, `NULL_NON_FINITE` and `binaryStandardHex`.

## Connection string

[`connection-string.ts`](../../src/lib/db/providers/sql/intercom/connection-string.ts) shows no connection string scheme. There is no `readTls`. There is no `paste`. There is no seed load check.

## Execution UI

[`execution-ui.ts`](../../src/lib/db/providers/sql/intercom/execution-ui.ts) names `COMMIT` on the rolled-back notice. The consent card has no consent deadline.

## Object edit (#789)

Intercom objects are not edited as source from the object tree. No kind declares `hasSource`. The absence is the one `tests/isolated/object-edit-declarations.test.ts` holds for this type-id. No kind declares `acceptsRowWrites` or `acceptsSourceEdits`. The connection is read-only.

## Migration DDL

[`INTERCOM_MIGRATION_DDL`](../../src/lib/db/providers/sql/intercom/migration-ddl.ts) declines the whole diff. `refusal` is the one line the migration prints after its header, and `transactionWrapper` is `null`.

The refusal reason it prints, verbatim:

- "Intercom object changes are not generated here; this connection is read-only."

## Query

Contacts and Conversations with a `WHERE` are `POST /contacts/search` or `POST /conversations/search`. A list without a filter is `GET /contacts` or `GET /conversations` with `per_page` and `starting_after`. Admins, tags, segments, and teams are one GET, and `WHERE`, `ORDER BY`, `LIMIT`, and `OFFSET` apply to that array. Nested objects flatten one level, so `source.type` is a column, and an array comes back as text. `SELECT` of named columns returns those columns. `SELECT *` returns the flattened keys. A `LIMIT` above 1000 warns that the read is 1000. An `OFFSET` past 1000 returns no rows and a warning, and it does not call the API. Generate Query omits `WHERE 1=1` (`supportsConstantPredicate` is false). `EXPLAIN` is not offered (`supportsExplain` is false). There is no maintenance operation. There is no agent language pack: `AGENT_STATEMENT_LANGUAGE` is null for this type-id, and MCP stays closed.
