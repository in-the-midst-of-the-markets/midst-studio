# Supabase Provider

Supabase is a hosted Postgres database, and this connection is the Postgres provider after the dialog's host is normalized. The SQL editor, the schema tree, explain, transactions and migration DDL are Postgres.

The host can be any of these:

- `db.<project-ref>.supabase.co`, the direct database host
- the pooler host Supabase shows (`*.pooler.supabase.com`)
- the project ref on its own
- `https://<project-ref>.supabase.co`
- a dashboard URL that contains `/project/<project-ref>`
- a `postgresql://` URL copied from the Supabase dashboard, pasted into the host field or into the connection-string paste box

An empty user becomes `postgres`. An empty database becomes `postgres`. An empty port becomes `5432`. The pooler often wants the user `postgres.<project-ref>`; type that when the direct user is refused. The password is the database password, not the anon key or the service role key.

A host that mentions Supabase uses TLS. A saved connection that left SSL off is turned to `require` before the pool opens, because Supabase does not accept a plaintext connection.

A pasted `postgresql://` URL is this connection only when the host mentions Supabase. Every other `postgresql://` URL stays a Postgres connection.

## SQL grammar

[`src/lib/db/providers/sql/supabase/sql-grammar.ts`](../../src/lib/db/providers/sql/supabase/sql-grammar.ts) declares `SUPABASE_GRAMMAR`. `readsSqlText` is `true`. Redaction is `sql` with `"` as its name quote.

`SUPABASE_GRAMMAR` is the Postgres grammar's own settings, copied onto this type-id so the editor highlights, formats and completes Postgres SQL. Comments are `--` and block comments. Names are double-quoted.

## SQL writing

[`supabase/sql-writing.ts`](../../src/lib/db/providers/sql/supabase/sql-writing.ts) is this engine's row of `SQL_WRITING`. It writes a literal, a name and a `$1` placeholder the way Postgres does.

A literal is written by `literalStandard` and read back by `unquoteStandard`. A name is quoted by `identifierDoubleQuoted`. A placeholder is `placeholderDollar`. `inlineEdit` uses `INSTANT_TYPE_NAMES`, `EXACT_DECIMAL_TYPE_NAMES` and `FLOAT64_TYPE_NAMES`.

The module's `export` field spells column types through `ddlTypes` (a binary column is `BYTEA`) and writes a binary cell with `binaryPgBytea`. `standsAlone` is the same list Postgres measured. `bareSpelling` writes a bare `bit` as `bit varying`. `nonFinite` is `QUOTED_WORD_NON_FINITE`. `typedLiteral` is `postgresLiteral`.

## Connection string

[`connection-string.ts`](../../src/lib/db/providers/sql/supabase/connection-string.ts) shows no connection string scheme. There is no `readTls`. Its `paste` claims a `postgresql://` URL whose host mentions Supabase and fills the host, port, user, password and database. There is no seed load check. A saved `connectionString` is opened by the Postgres provider.

## Execution UI

[`execution-ui.ts`](../../src/lib/db/providers/sql/supabase/execution-ui.ts) names `COMMIT` on the rolled-back notice. The consent card has no consent deadline.

## Object edit (#789)

Object edit is not declared on this type-id. The SQL editor and the schema tree are the Postgres ones. The absence is the one `tests/isolated/object-edit-declarations.test.ts` holds for this type-id.

Supabase inherits the Postgres object kinds, including views, functions and procedures, so the tree can show their source. It does not declare `acceptsSourceEdits` or `acceptsRowWrites`.

## Migration DDL

[`SUPABASE_MIGRATION_DDL`](../../src/lib/db/providers/sql/supabase/migration-ddl.ts) writes Postgres table DDL. `transactionWrapper` is `BEGIN_COMMIT`. The statements are `standardPrimaryKey`, `standardCreateTableForeignKey`, `standardColumnDef`, `standardCreateIndex`, `standardDropIndex`, `standardAddForeignKey`, `standardDropForeignKey`, `standardAddColumn`, `standardDropColumn`, `standardModifyColumn` and `standardDropTable`.

## Query

A statement is sent to Postgres unchanged. `EXPLAIN`, transactions and the schema catalog are the Postgres provider's.
