# Stripe Provider

Stripe is its own connection type. Studio reaches an account over the Stripe API (`https://api.stripe.com`). It is not a SQL server, and the rows are not copied into another database. The editor still runs SQL: one `SELECT` or `COUNT(*)` is translated into that API before anything is sent. A write is refused before a request. The connection is read-only.

The connection is a secret or restricted key in the password field. The key needs read access to the objects you query. The API host defaults to `api.stripe.com`. The key is sent only to a host under `stripe.com`, over HTTPS, and a redirect is not followed. The dialog has no TLS panel and no SSH tunnel. Requests send `Stripe-Version: 2026-10-28.endive`.

The object tree is one account. The objects are customers, charges, payment intents, invoices, subscriptions, products, prices, refunds, payouts, balance transactions, disputes, and events. Columns are fixed. Amounts stay in the smallest currency unit. `created` and the other epoch columns are Unix seconds and come back as ISO timestamps. The `id` column is the object id.

## SQL grammar

[`src/lib/db/providers/sql/stripe/sql-grammar.ts`](../../src/lib/db/providers/sql/stripe/sql-grammar.ts) declares `STRIPE_GRAMMAR`. `readsSqlText` is `true`. Redaction is `sql` with `"` as its name quote.

Comments are `--` and `/* */`. `#` is code. `//` is not a comment. Names are double-quoted. Format uses sql-formatter's MySQL language (the grammar's `formatterLanguage`).

The editor offers only the words this subset runs (`completionWords` with `lists: "only"`): `SELECT`, `WHERE`, `AND`, `ORDER BY`, `DESC`, `LIMIT`, `OFFSET` and `COUNT`. It does not offer `INSERT`, `UPDATE`, `DELETE`, `JOIN`, `GROUP BY` or the shared function list. `SELECT` and `COUNT` are snippets, and each one is a statement this connection can run. Generate Query names the columns when there are at most eight, and writes `SELECT *` under a comment when an object has more fields than that.

What the provider actually runs is the subset, and a statement outside it fails before a request:

- `SELECT` columns or `*` from one object, with `WHERE` comparisons combined with `AND`, `ORDER BY created DESC`, `LIMIT` and `OFFSET`.
- `COUNT(*)` from one searchable object.

A list filter (`email` on customers, `customer` on charges, and the other equality filters each object documents) is sent to the list endpoint, which is consistent. A field the list endpoint does not filter is sent to search when that object can be searched. Search is eventually consistent. `WHERE id = '...'` alone retrieves that one object. `id` plus another condition is refused.

`created` is a range of Unix seconds (`<`, `<=`, `>`, `>=`). `OR`, a join, any other aggregate, `WITH`, `DISTINCT`, `IN`, `BETWEEN`, `NOT`, `IS NULL`, and a parameter list are refused with a sentence that says what to write instead. A result always includes `id`. One statement reads at most 1000 rows.

`COUNT(*)` uses search `expand[]=total_count`. Stripe reports at most 10000, and a larger match set is warned about. A list-only object (refunds, payouts, balance transactions, disputes, events) has no total, and `COUNT(*)` on it is refused unless the filter is one id.

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

`SELECT` paging is `LIMIT n` and `LIMIT n OFFSET m`. The shared limiter appends the page bound. List pages use `starting_after`. Search pages use `page`. Offset is a number of rows, not that cursor. Pages are 100 records. An offset of 1000 or more is refused.

The connect probe is `GET /v1/customers?limit=1`, so a key without that read fails at connect. Generate Query omits `WHERE 1=1` (`supportsConstantPredicate` is false), because that predicate is not a field comparison the translator can send.

`EXPLAIN` is not offered (`supportsExplain` is false). There is no maintenance operation. There is no agent language pack: `AGENT_STATEMENT_LANGUAGE` is null for this type-id, and MCP stays closed.
