# Stardog Provider

Stardog is its own connection type. Studio reaches one database over the SPARQL protocol (`POST /{database}/query`). It is not a SQL server, and the triples are not copied into another database. The editor writes SPARQL: one `SELECT` or `ASK`. This connection does not write.

The connection is a host, a port (5820 when none is set), a database name, a user and a password. The password is sent as Basic authentication, and only to that host. HTTPS is the default. A password sent without TLS to a host that is not this machine is refused until "Send the password without TLS" is ticked. A live server was not measured; the provider was written against a scripted HTTP client.

The object tree lists classes from `SELECT DISTINCT ?class WHERE { ?s a ?class }`, at most 200. Columns are the properties of that class, at most 80. A class name in the tree is its IRI.

## SQL grammar

[`src/lib/db/providers/sql/stardog/sql-grammar.ts`](../../src/lib/db/providers/sql/stardog/sql-grammar.ts) declares `STARDOG_GRAMMAR`. `readsSqlText` is `true`. Redaction is `sql` with `"` as its name quote.

`#` starts a comment. `//` is not a comment. An IRI is wrapped in `<>` when a suggestion inserts it. Format uses sql-formatter's MySQL language (the grammar's `formatterLanguage`).

The editor offers only the words a read runs (`completionWords` with `lists: "only"`): `SELECT`, `ASK`, `WHERE`, `OPTIONAL`, `FILTER`, `BIND`, `PREFIX`, `a`, `LIMIT` and the rest of that list. It does not offer `JOIN`, `INSERT` or the shared function list. After `a`, the suggestion is a class. On an empty SQL editor for any other engine, the suggestion is a query of a table the connection already lists, using that table's columns, and a column you have started to type ranks ahead of a keyword that shares those letters.

What the provider sends is the statement, and a statement that is not a `SELECT` or an `ASK` fails before a request. `INSERT`, `DELETE`, `LOAD`, `CLEAR`, `DROP`, `CREATE`, `COPY` and `MOVE` are refused. A word inside a string or an IRI is not read as one of those verbs.

## SQL writing

[`sql-writing.ts`](../../src/lib/db/providers/sql/stardog/sql-writing.ts) declares how a generated statement spells a literal, a name and a bind, and it is this engine's row of `SQL_WRITING`.

A literal is written by `literalStandard` and read back by `unquoteStandard`. A name is quoted by `identifierDoubleQuoted`. There is no placeholder: the query API does not bind parameters, and `query()` refuses a parameter list.

`inlineEdit` uses `INSTANT_TYPE_NAMES`, `FLOAT64_TYPE_NAMES` and `EXACT_DECIMAL_TYPE_NAMES`. The provider does not offer inline row edit.

The module's `export` field writes a result export from `STANDARD_DDL_TYPES`, `NOTHING_STANDS_ALONE`, `NO_BARE_SPELLING`, `NULL_NON_FINITE` and `binaryStandardHex`.

## Connection string

[`connection-string.ts`](../../src/lib/db/providers/sql/stardog/connection-string.ts) shows no connection string scheme. There is no `readTls`. There is no `paste`. There is no seed load check.

## Execution UI

[`execution-ui.ts`](../../src/lib/db/providers/sql/stardog/execution-ui.ts) names `COMMIT` on the rolled-back notice. The consent card has no consent deadline.

## Object edit (#789)

Stardog classes are not edited as source from the object tree. No kind declares `hasSource`. The absence is the one `tests/isolated/object-edit-declarations.test.ts` holds for this type-id.

## Migration DDL

[`STARDOG_MIGRATION_DDL`](../../src/lib/db/providers/sql/stardog/migration-ddl.ts) declines the whole diff. `refusal` is the one line the migration prints after its header, and `transactionWrapper` is `null`.

The refusal reason it prints, verbatim:

- "Stardog class changes are not generated here; add the class in Stardog."

## Query

The query resource is `POST /{database}/query` with the statement in a form field and `Accept: application/sparql-results+json`. An ASK is one row, column `ask`. A literal with an integer, decimal, double or float datatype is a number. Any other value is the text, cut at 4000 characters.

`EXPLAIN` is not offered (`supportsExplain` is false). There is no maintenance operation. The shared SQL limiter does not rewrite a SPARQL statement (`prepareQuery` returns it unchanged).
