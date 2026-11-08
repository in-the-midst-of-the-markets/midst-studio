# Stripe Provider

Stripe is its own connection type. Studio reaches an account over the Queries and Reports API (`https://api.stripe.com`). It is not a SQL server, and the rows are not copied into another database. The editor runs Sigma SQL: a `SELECT` or `WITH` query is sent as a query run. A `REPORT` statement runs a report template. A write is refused before a request. The connection is read-only.

The connection is a secret or restricted key in the password field. A query needs Data, Queries, Read (`data_queries_read`). A report needs Data, Reports, Read (`data_reports_read`). The API host is `api.stripe.com`. The key is sent only there, over TLS, on the shared HTTP transport. That path does not use global fetch, so a proxy setting cannot carry the key. Any other host is refused, and the refusal does not repeat the host or the key. A redirect is not followed. The dialog has no TLS panel and no SSH tunnel. Requests send `Stripe-Version: 2026-10-28.preview`.

The object tree has two datasets. `analytical` is the tables from the schema list, the same tables Sigma shows. `reports` is the report templates. Columns on a table come from its schema. Columns on a report are the parameters it accepts. Amounts stay in the smallest currency unit. A finished run is read back as inline rows, at most 1000 of them. Studio does not open the result file: that URL is on another host, and the key is not sent there.

## SQL grammar

[`src/lib/db/providers/sql/stripe/sql-grammar.ts`](../../src/lib/db/providers/sql/stripe/sql-grammar.ts) declares `STRIPE_GRAMMAR`. `readsSqlText` is `true`. Redaction is `sql` with `"` as its name quote.

Comments are `--` and `/* */`. `#` is code. `//` is not a comment. Names are double-quoted. Format uses sql-formatter's PostgreSQL language, the default when a grammar names none.

Completion keeps the shared SQL words, so `JOIN`, `GROUP BY`, `WITH`, `ORDER BY` and the shared functions are offered. It adds `REPORT`, `date_format` and `date_trunc`. `SELECT` and `REPORT` are snippets. Generate Query names the columns when there are at most eight, and writes `SELECT *` under a comment when a table has more fields than that. A click on a table runs `SELECT *` from that table. A click on a report runs that report when it has no required parameter, and otherwise tells you the `REPORT` statement to write.

What the provider sends:

- `SELECT` or `WITH` text, as written, to `POST /v2/data/query_runs` on the `analytical` dataset. One trailing semicolon is removed. A second statement is refused.
- `REPORT name` or `REPORT name (parameter => 'value', ...)`. A value is quoted text, a whole number, or true or false. The run is `POST /v2/data/report_runs`.

A query or a report run is asynchronous. Studio polls the run until it succeeds, fails, or the connection's query timeout passes. The rows come from `include[0]=result.inline`. A page that says another page exists is warned about, and that page is not followed, so a next-page URL cannot move the key off `api.stripe.com`.

`INSERT`, `UPDATE`, `DELETE` and any other statement are refused before a request. A parameter list is refused. The API does not bind parameters.

## SQL writing

[`stripe/sql-writing.ts`](../../src/lib/db/providers/sql/stripe/sql-writing.ts) declares how a generated statement spells a literal, a name and a bind, and it is this engine's row of `SQL_WRITING`.

A literal is written by `literalStandard` and read back by `unquoteStandard`. A name is quoted by `identifierDoubleQuoted`. There is no placeholder: the API does not bind parameters, and `query()` refuses a parameter list.

`inlineEdit` uses `INSTANT_TYPE_NAMES`, `FLOAT64_TYPE_NAMES` and `EXACT_DECIMAL_TYPE_NAMES`. The provider does not offer inline row edit.

The module's `export` field writes a result export from `STANDARD_DDL_TYPES`, `NOTHING_STANDS_ALONE`, `NO_BARE_SPELLING`, `NULL_NON_FINITE` and `binaryStandardHex`.

## Connection string

[`connection-string.ts`](../../src/lib/db/providers/sql/stripe/connection-string.ts) shows no connection string scheme. There is no `readTls`. There is no `paste`. There is no seed load check.

## Execution UI

[`execution-ui.ts`](../../src/lib/db/providers/sql/stripe/execution-ui.ts) names `COMMIT` on the rolled-back notice. The consent card has no consent deadline.

## Object edit (#789)

Stripe objects are not edited as source from the object tree. No kind declares `hasSource`. The absence is the one `tests/isolated/object-edit-declarations.test.ts` holds for this type-id. No kind declares `acceptsRowWrites` or `acceptsSourceEdits`. The SQL editor is the way a row is read, and a write is refused.

## Migration DDL

[`STRIPE_MIGRATION_DDL`](../../src/lib/db/providers/sql/stripe/migration-ddl.ts) declines the whole diff. `refusal` is the one line the migration prints after its header, and `transactionWrapper` is `null`.

The refusal reason it prints, verbatim:

- "Stripe object changes are not generated here; this connection is read-only."

## Query

The connect probe lists schemas, then reports. A key that cannot read schemas can still connect when it can read reports, and the other way around. A key that can read neither fails at connect. Generate Query omits `WHERE 1=1` (`supportsConstantPredicate` is false).

`EXPLAIN` is not offered (`supportsExplain` is false). There is no maintenance operation. There is no agent language pack: `AGENT_STATEMENT_LANGUAGE` is null for this type-id, and MCP stays closed.
