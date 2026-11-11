# PayPal Provider

PayPal is its own connection type. Studio reaches one PayPal account over the REST API (`https://api-m.paypal.com`). It is not a SQL server. The editor still runs SQL: one `SELECT` is one list, and the filter, the order and the page are applied to that answer. A write is refused before a request. The rows are not copied into another database. The connection is read-only. The next page is not requested.

The user field is the REST app client id. The password is the client secret. Studio exchanges them for an access token at `POST /v1/oauth2/token` and sends that token as `Authorization: Bearer`. It does not put the id or the secret in a URL. The host is `api-m.paypal.com`, or `api-m.sandbox.paypal.com` for a sandbox app. An empty host uses the live host. Any other host is refused, and the refusal does not repeat the host or the secret. The dialog has no TLS panel and no SSH tunnel. The database field is not used.

The object tree is one account and the lists this connection shows: `transaction`, `balance`, `invoice`, `dispute`, `product`, `plan` and `payout`. Transactions are the last 30 days, one page of at most 500. The other lists are one page of the size PayPal allows for that list.

## SQL grammar

[`src/lib/db/providers/sql/paypal/sql-grammar.ts`](../../src/lib/db/providers/sql/paypal/sql-grammar.ts) declares `PAYPAL_SQL_GRAMMAR`, whose `grammar` is `PAYPAL_GRAMMAR`. `readsSqlText` is `true`. Redaction is `sql` with `"` as its name quote.

Comments are `--` and `/* */`. `#` is code. `//` is not a comment. Names are double-quoted. Format uses sql-formatter's MySQL language (the grammar's `formatterLanguage`).

The editor offers only the words this subset runs (`completionWords` with `lists: "only"`): `SELECT`, `FROM`, `WHERE`, `AND`, `ORDER BY`, `ASC`, `DESC`, `LIMIT`, `OFFSET`, `LIKE`, `IS NULL` and `IS NOT NULL`. It does not offer `INSERT`, `UPDATE`, `DELETE`, `JOIN`, `COUNT` or the shared function list. A field whose name contains a dot, such as `transaction.amount`, is completed as that one word. The `SELECT` snippet is a statement this connection can run.

What the provider actually runs is the subset, and a statement outside it fails before a request:

- `SELECT` columns or `*` from one listed resource, such as `transaction` or `invoice`. A field is the name this connection lists, such as `transaction.status` or `invoice.number`.
- `WHERE` comparisons (`=`, `!=`, `<>`, `<`, `>`, `<=`, `>=`), `LIKE`, `IS NULL` and `IS NOT NULL`. `AND` only. Text values are quoted (`transaction.status = 'S'`). A number is unquoted. `LIKE` applies to a text field.
- `ORDER BY` one field. A null sorts last.
- `LIMIT` and `OFFSET`, capped at 500 rows. The default limit is 100. Studio keeps the page locally. An `OFFSET` of 500 or more returns no rows and does not call the API.

`COUNT(*)`, `OR`, a join, `IN`, `DISTINCT`, a second statement, and a parameter list are refused.

## SQL writing

[`paypal/sql-writing.ts`](../../src/lib/db/providers/sql/paypal/sql-writing.ts) declares how a generated statement spells a literal, a name and a bind, and it is this engine's row of `SQL_WRITING`.

A literal is written by `literalStandard` and read back by `unquoteStandard`. A name is quoted by `identifierDoubleQuoted`. There is no placeholder: the API does not bind parameters, and `query()` refuses a parameter list.

`inlineEdit` uses `INSTANT_TYPE_NAMES`, `FLOAT64_TYPE_NAMES` and `EXACT_DECIMAL_TYPE_NAMES`. The provider does not offer inline row edit.

The module's `export` field writes a result export from `STANDARD_DDL_TYPES`, `NOTHING_STANDS_ALONE`, `NO_BARE_SPELLING`, `NULL_NON_FINITE` and `binaryStandardHex`.

## Connection string

[`connection-string.ts`](../../src/lib/db/providers/sql/paypal/connection-string.ts) shows no connection string scheme. There is no `readTls`. There is no `paste`. There is no seed load check.

## Execution UI

[`execution-ui.ts`](../../src/lib/db/providers/sql/paypal/execution-ui.ts) names `COMMIT` on the rolled-back notice. The consent card has no consent deadline.

## Object edit (#789)

PayPal objects are not edited as source from the object tree. No kind declares `hasSource`. The absence is the one `tests/isolated/object-edit-declarations.test.ts` holds for this type-id. No kind declares `acceptsRowWrites` or `acceptsSourceEdits`. The connection is read-only.

## Migration DDL

[`PAYPAL_MIGRATION_DDL`](../../src/lib/db/providers/sql/paypal/migration-ddl.ts) declines the whole diff. `refusal` is the one line the migration prints after its header, and `transactionWrapper` is `null`.

The refusal reason it prints, verbatim:

- "PayPal object changes are not generated here; this connection is read-only."

## Query

Connect exchanges the client id and secret and does not read a list. A `SELECT` then sends the access token.

- `transaction` is `GET /v1/reporting/transactions` with `start_date` and `end_date` covering the last 30 days, `page_size=500` and `fields=transaction_info,payer_info`. A transaction status `S` is successful.
- `balance` is `GET /v1/reporting/balances`.
- `invoice` is `GET /v2/invoicing/invoices` with `page_size=100`.
- `dispute` is `GET /v1/customer/disputes` with `page_size=50`.
- `product` is `GET /v1/catalogs/products` with `page_size=20`.
- `plan` is `GET /v1/billing/plans` with `page_size=20`.
- `payout` is `GET /v1/payments/payouts` with `page_size=500`.

`SELECT` of named columns returns those columns. `SELECT *` returns the columns this connection lists for that resource. Amounts stay the decimal strings PayPal sent, and a nested value is flattened onto the column. A `LIMIT` above 500 warns that the read is one page. An answer whose `total_pages` is greater than 1, or whose `links` contain `rel: next`, warns the same way, and that page is not followed. An `OFFSET` past 500 returns no rows and a warning, and it does not call the API. Generate Query omits `WHERE 1=1` (`supportsConstantPredicate` is false). `EXPLAIN` is not offered (`supportsExplain` is false). There is no maintenance operation. There is no agent language pack: `AGENT_STATEMENT_LANGUAGE` is null for this type-id, and MCP stays closed.
