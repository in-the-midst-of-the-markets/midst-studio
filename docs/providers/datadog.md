# Datadog Provider

Datadog is its own connection type. Studio reaches a Datadog organization over the REST API (`https://api.datadoghq.com` by default, or another official site). It is not a SQL server, and the rows are not copied into another database. The editor still runs SQL: one `SELECT` or `COUNT(*)` is one GET. A write is refused before a request. The connection is read-only.

The connection is an API key and an application key. The API key is the user field and the application key is the password field. They are sent only to an official Datadog API host, as `DD-API-KEY` and `DD-APPLICATION-KEY`, over TLS, on the shared HTTP transport. That path does not use global fetch, so a proxy setting cannot carry the keys. An empty host uses `api.datadoghq.com` (US1). A site name such as `eu`, `us3`, `us5`, `ap1`, `ap2`, `uk1`, `gov` or `us2-fed` selects that site's API host. The product site (`app.datadoghq.com`) and any other host are refused, and the refusal does not repeat the host or the keys. A redirect is not followed. The dialog has no TLS panel and no SSH tunnel.

The object tree is one organization and the lists this connection reads: monitors, hosts, and dashboards. A monitor page is at most 100 rows and defaults to 30. A host page is at most 1000 and defaults to 100. A dashboard page is at most 100. `OFFSET` must be a multiple of `LIMIT`.

## SQL grammar

[`src/lib/db/providers/sql/datadog/sql-grammar.ts`](../../src/lib/db/providers/sql/datadog/sql-grammar.ts) declares `DATADOG_GRAMMAR`. `readsSqlText` is `true`. Redaction is `sql` with `"` as its name quote.

Comments are `--` and `/* */`. `#` is code. `//` is not a comment. Names are double-quoted. Format uses sql-formatter's MySQL language (the grammar's `formatterLanguage`).

The editor offers only the words this subset runs (`completionWords` with `lists: "only"`): `SELECT`, `FROM`, `WHERE`, `AND`, `AS`, `LIMIT`, `OFFSET` and `COUNT`. It does not offer `INSERT`, `UPDATE`, `DELETE`, `JOIN`, `OR`, `ORDER BY` or the shared function list. After `FROM` it offers the lists this connection reads: Monitor, Host and Dashboard. A select list offers those lists' columns. Inside `WHERE` it offers the filters the list accepts, and the status, boolean and sort values those filters take. A field whose name contains a dot is completed as that one word. The snippets are statements this connection can run: monitors in alert, a monitor search, an alerting-monitor count, hosts, a host count, and dashboards. Generate Query names the columns when there are at most eight, and writes `SELECT *` under a comment when the table has more fields than that.

What the provider actually runs is the subset, and a statement outside it fails before a request:

- `SELECT` columns or `*` from one listed table.
- `WHERE` equalities (`=`) of quoted values, numbers, or `true` and `false`. `AND` only. A column is sent only when that list documents it as a filter.
- Monitor `Status` is `Alert`, `Warn`, `OK`, `No Data`, `Ignored`, `Skipped` or `Unknown`. Monitor `Query` is the search text from the Monitors page, such as `type:metric`.
- Host `Filter` is a host search such as `env:prod`. `SortField` is a short name such as `name` or `cpu`. `SortDir` is `asc` or `desc`. `From` is a whole number of seconds since the epoch.
- Dashboard `Shared` and `Deleted` are `true` or `false`, and a statement sets only one of them.
- `LIMIT` is the page size. A larger `LIMIT` is read at the page maximum and warned. `OFFSET` must be a multiple of `LIMIT`. Host `start` is the number of hosts to skip.
- `COUNT(*)` reads `metadata.total_count` for monitors and `total_matching` for hosts. Dashboards do not return a total, so a count of that table is refused.

`OR`, a join, `ORDER BY`, a second statement, and a parameter list are refused.

## SQL writing

[`datadog/sql-writing.ts`](../../src/lib/db/providers/sql/datadog/sql-writing.ts) declares how a generated statement spells a literal, a name and a bind, and it is this engine's row of `SQL_WRITING`.

A literal is written by `literalStandard` and read back by `unquoteStandard`. A name is quoted by `identifierDoubleQuoted`. There is no placeholder: the API does not bind parameters, and `query()` refuses a parameter list.

`inlineEdit` uses `INSTANT_TYPE_NAMES`, `FLOAT64_TYPE_NAMES` and `EXACT_DECIMAL_TYPE_NAMES`. The provider does not offer inline row edit.

The module's `export` field writes a result export from `STANDARD_DDL_TYPES`, `NOTHING_STANDS_ALONE`, `NO_BARE_SPELLING`, `NULL_NON_FINITE` and `binaryStandardHex`.

## Connection string

[`connection-string.ts`](../../src/lib/db/providers/sql/datadog/connection-string.ts) shows no connection string scheme. There is no `readTls`. There is no `paste`. There is no seed load check.

## Execution UI

[`execution-ui.ts`](../../src/lib/db/providers/sql/datadog/execution-ui.ts) names `COMMIT` on the rolled-back notice. The consent card has no consent deadline.

## Object edit (#789)

Datadog objects are not edited as source from the object tree. No kind declares `hasSource`. The absence is the one `tests/isolated/object-edit-declarations.test.ts` holds for this type-id. No kind declares `acceptsRowWrites` or `acceptsSourceEdits`. The connection is read-only.

## Migration DDL

[`DATADOG_MIGRATION_DDL`](../../src/lib/db/providers/sql/datadog/migration-ddl.ts) declines the whole diff. `refusal` is the one line the migration prints after its header, and `transactionWrapper` is `null`.

The refusal reason it prints, verbatim:

- "Datadog object changes are not generated here; this connection is read-only."

## Query

Monitors are `GET /api/v1/monitor/search` with `page`, `per_page` and `query`. A status filter is `status:alert` (or the other documented state). Hosts are `GET /api/v1/hosts` with `count`, `start`, `filter`, `sort_field`, `sort_dir` and `from`, and the request asks for mute state and host metadata. `start` is how many hosts to skip. Datadog's own page describes the second page of 100 as `start=101`; this connection sends the number of hosts to skip, so that page is `start=100`. Dashboards are `GET /api/v1/dashboard` with `count`, `start`, and either `filter[shared]` or `filter[deleted]`. The rows are `monitors`, `host_list` or `dashboards`. A full page warns that the next page needs a larger `OFFSET`.

Connect is `GET /api/v1/validate`. A body whose `valid` field is not true is an authentication failure. A 401 is an authentication failure and a 403 is a refusal. A body with an `errors` array is a refusal, and the first error is repeated only when it is a short sentence. The keys are not written into the error.

Generate Query omits `WHERE 1=1` (`supportsConstantPredicate` is false). `EXPLAIN` is not offered (`supportsExplain` is false). There is no maintenance operation. There is no agent language pack: `AGENT_STATEMENT_LANGUAGE` is null for this type-id, and MCP stays closed.
