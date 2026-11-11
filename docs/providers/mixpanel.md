# Mixpanel Provider

Mixpanel is its own connection type. Studio reaches one Mixpanel project over the Query API and the annotations API (`https://mixpanel.com`). It is not a SQL server. The editor still runs SQL: one `SELECT` is one list, and the filter, the order and the page are applied to that answer. A write is refused before a request. The rows are not copied into another database. The connection is read-only. The next page is not requested.

The user field is the service account username. The password is the service account secret. Studio sends them as `Authorization: Basic` and does not put either value in a URL. The database field is the numeric project id, sent as `project_id` or as the project segment of the annotations path. The host is `mixpanel.com`, `eu.mixpanel.com`, or `in.mixpanel.com`. An empty host uses the US host. Any other host is refused, and the refusal does not repeat the host or the secret. The dialog has no TLS panel and no SSH tunnel.

A live project was not probed. The statements below are the ones this provider sends.

The object tree is one project and the lists this connection shows: `event`, `annotation` and `cohort`. Events are today's top events, at most 100. Annotations and cohorts are the project's lists, and Studio keeps at most 100 rows of each answer.

## SQL grammar

[`src/lib/db/providers/sql/mixpanel/sql-grammar.ts`](../../src/lib/db/providers/sql/mixpanel/sql-grammar.ts) declares `MIXPANEL_SQL_GRAMMAR`, whose `grammar` is `MIXPANEL_GRAMMAR`. `readsSqlText` is `true`. Redaction is `sql` with `"` as its name quote.

Comments are `--` and `/* */`. `#` is code. `//` is not a comment. Names are double-quoted. Format uses sql-formatter's MySQL language (the grammar's `formatterLanguage`).

The editor offers only the words this subset runs (`completionWords` with `lists: "only"`): `SELECT`, `FROM`, `WHERE`, `AND`, `ORDER BY`, `ASC`, `DESC`, `LIMIT`, `OFFSET`, `LIKE`, `IS NULL` and `IS NOT NULL`. It does not offer `INSERT`, `UPDATE`, `DELETE`, `JOIN`, `COUNT` or the shared function list. A field whose name contains a dot, such as `event.name`, is completed as that one word. The `SELECT` snippet is a statement this connection can run.

What the provider actually runs is the subset, and a statement outside it fails before a request:

- `SELECT` columns or `*` from one listed resource, such as `event` or `cohort`. A field is the name this connection lists, such as `event.name` or `cohort.count`.
- `WHERE` comparisons (`=`, `!=`, `<>`, `<`, `>`, `<=`, `>=`), `LIKE`, `IS NULL` and `IS NOT NULL`. `AND` only. Text values are quoted (`event.name = 'Sign Up'`). A number is unquoted. `LIKE` applies to a text field.
- `ORDER BY` one field. A null sorts last.
- `LIMIT` and `OFFSET`, capped at 100 rows. The default limit is 100. Studio keeps the page locally. An `OFFSET` of 100 or more returns no rows and does not call the API.

`COUNT(*)`, `OR`, a join, `IN`, `DISTINCT`, a second statement, and a parameter list are refused.

## SQL writing

[`mixpanel/sql-writing.ts`](../../src/lib/db/providers/sql/mixpanel/sql-writing.ts) declares how a generated statement spells a literal, a name and a bind, and it is this engine's row of `SQL_WRITING`.

A literal is written by `literalStandard` and read back by `unquoteStandard`. A name is quoted by `identifierDoubleQuoted`. There is no placeholder: the API does not bind parameters, and `query()` refuses a parameter list.

`inlineEdit` uses `INSTANT_TYPE_NAMES`, `FLOAT64_TYPE_NAMES` and `EXACT_DECIMAL_TYPE_NAMES`. The provider does not offer inline row edit.

The module's `export` field writes a result export from `STANDARD_DDL_TYPES`, `NOTHING_STANDS_ALONE`, `NO_BARE_SPELLING`, `NULL_NON_FINITE` and `binaryStandardHex`.

## Connection string

[`connection-string.ts`](../../src/lib/db/providers/sql/mixpanel/connection-string.ts) shows no connection string scheme. There is no `readTls`. There is no `paste`. There is no seed load check.

## Execution UI

[`execution-ui.ts`](../../src/lib/db/providers/sql/mixpanel/execution-ui.ts) names `COMMIT` on the rolled-back notice. The consent card has no consent deadline.

## Object edit (#789)

Mixpanel objects are not edited as source from the object tree. No kind declares `hasSource`. The absence is the one `tests/isolated/object-edit-declarations.test.ts` holds for this type-id. No kind declares `acceptsRowWrites` or `acceptsSourceEdits`. The connection is read-only.

## Migration DDL

[`MIXPANEL_MIGRATION_DDL`](../../src/lib/db/providers/sql/mixpanel/migration-ddl.ts) declines the whole diff. `refusal` is the one line the migration prints after its header, and `transactionWrapper` is `null`.

The refusal reason it prints, verbatim:

- "Mixpanel object changes are not generated here; this connection is read-only."

## Query

Connect reads `GET /api/query/events/top` with `type=general` and `limit=1`. A `SELECT` then sends the same Basic header.

- `event` is `GET /api/query/events/top` with `project_id`, `type=general` and `limit=100`. `amount` is `event.count`. `percent_change` is `event.change`.
- `annotation` is `GET /api/app/projects/{projectId}/annotations`.
- `cohort` is `POST /api/query/cohorts/list` with `project_id`. The body is empty. `is_visible` of `1` is `cohort.visible` = `yes`.

`SELECT` of named columns returns those columns. `SELECT *` returns the columns this connection lists for that resource. A `LIMIT` above 100 warns that the read is one page. An answer of 100 rows warns the same way, and another page is not requested. An `OFFSET` past 100 returns no rows and a warning, and it does not call the API. Generate Query omits `WHERE 1=1` (`supportsConstantPredicate` is false). `EXPLAIN` is not offered (`supportsExplain` is false). There is no maintenance operation. There is no agent language pack: `AGENT_STATEMENT_LANGUAGE` is null for this type-id, and MCP stays closed.
