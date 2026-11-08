/**
 * How Ask AI should write one statement for the engine that is connected.
 *
 * SQL engines stay on the read-only SQL sentence. A search engine's editor also
 * runs a Dev Tools request, and a vector engine runs its own request, so those
 * chats are told that shape. The braces in a vector value are filled by the
 * embedding model chosen beside Lines. They are not a chart filter and not a
 * list of numbers.
 */

import { AGENT_STATEMENT_LANGUAGE } from "@/lib/agent/agent-manifest";

const STATEMENT_LANGUAGE: Readonly<Record<string, string | null>> = AGENT_STATEMENT_LANGUAGE;
import { devToolsAction, readDevToolsRequest } from "@/lib/db/search-dev-tools";
import type { ConsoleDialectSpec, RouteSpec } from "@/lib/db/console/dialect";
import { MILVUS_CONSOLE, MILVUS_ROUTES } from "@/lib/db/providers/vector/milvus/routes";
import { milvusStatementLanguage } from "@/lib/db/providers/vector/milvus/labels";
import { QDRANT_CONSOLE, QDRANT_ROUTES } from "@/lib/db/providers/vector/qdrant/routes";
import { QDRANT_REFUSED_CLASSES, qdrantStatementLanguage } from "@/lib/db/providers/vector/qdrant/labels";
import { WEAVIATE_CONSOLE, WEAVIATE_ROUTES } from "@/lib/db/providers/vector/weaviate/routes";
import { WEAVIATE_REFUSED_CLASSES, weaviateStatementLanguage } from "@/lib/db/providers/vector/weaviate/labels";
import { embedProbeText } from "@/lib/embeddings/placeholder";

const SQL_RULE = "sql is one read-only statement for this engine.";
const CYPHER_RULE = "sql is one read-only Cypher statement for this engine. Do not write SQL.";
const SQL_SAMPLE = "one read-only SELECT with LIMIT 200";
const CYPHER_SAMPLE = "one read-only Cypher statement";
const VECTOR_SAMPLE = "one read request in this engine's language, and a vector value is {{the words}}";

const EMBEDDING = [
  "Dynamic embeddings: the embedding model chosen beside Lines turns words into the vector when the query runs.",
  "Write those words as the whole vector value, in braces and not in quotes.",
  "Do not write a list of numbers, a dimension, or a sample vector.",
  "Do not quote the braces.",
  "The same braces in any other field are a chart filter, not an embedding, so do not add them on k, a limit, or a filter.",
  "When the current statement already has a {{token}} as the vector value, keep it: that token is a filter, and the text typed in the filter is what gets embedded.",
  "A new search puts the words themselves inside the braces.",
  'The older {{embed "text"}} form still embeds that quoted text. Prefer {{the words}} as the vector value.',
].join(" ");

const SEARCH_RULE = [
  "sql is one read the editor can run on this search engine.",
  "A JSON search is a Dev Tools request, not SQL and not a bare JSON object: one line GET or POST, then a path such as company_profiles/_search, then one JSON object.",
  "A count is POST company_profiles/_count.",
  "Do not write a request that inserts, updates, or deletes a document.",
  "The editor runs that request as written.",
  "A statement that is already SQL stays one read-only SQL statement, and a vector in that SQL is the second argument of knn, written as {{the words}}.",
  'In the JSON body the vector value is written "vector": {{the words}}.',
  EMBEDDING,
].join(" ");

const SEARCH_SAMPLE = "POST index/_search then one JSON object, and a vector value is {{the words}}";

const VECTOR_EMBEDDING = [
  "Ignore the list of numbers in any example.",
  "Write the dynamic embedding there instead.",
  'Milvus holds one vector as "data": [{{the words}}].',
  'Qdrant writes "query": {{the words}} when query is the vector and not an object.',
  "A value of vector or nearest is {{the words}}.",
  EMBEDDING,
].join(" ");

const SQL_VALUES = [
  "Every comparison in WHERE or HAVING is a placeholder the chart can edit, even when the question did not ask for a filter.",
  "Write it where the literal would go, with no quotes around it: region = {{region:east|east,west,north}}.",
  "The default follows the colon.",
  "Category choices follow a pipe and are separated by commas.",
  "A comparison on a numeric column uses >=, <=, or =, a numeric default, and no choices.",
  "The placeholder name is the original column, as in total >= {{total:10}}.",
  "A renamed column is not that name: region AS area is filtered as region = {{region:east}}, not area.",
  "The studio substitutes a SQL literal before running and shows a Filters control for each placeholder.",
  "A connection whose engine is neo4j takes one read-only Cypher statement with its values in place.",
  "Do not write SQL or a placeholder on that connection.",
  "A question about an amount returns one category column and one number.",
  "A question about how records connect returns the relationship or the path.",
].join(" ");

const CYPHER_VALUES = [
  "Write each Cypher statement with its values in place.",
  "Do not write SQL or a placeholder.",
  "A question about an amount returns one category column and one number, and chart.type is bar or line.",
  "A question about how records connect returns the relationship or the path.",
  "chart may be null for that query; the studio draws the graph from the records that come back.",
].join(" ");

const EMBEDDING_VALUES = [
  "A vector value is {{the words}}, as the statement rule describes.",
  "Do not add a chart-filter placeholder in a JSON body.",
  "A connection whose engine is neo4j takes one read-only Cypher statement with its values in place.",
  "Do not write SQL or a placeholder on that connection.",
].join(" ");

interface Dialect {
  readonly rule: string;
  readonly sample: string;
  readonly values: string;
  readonly read: (sql: string) => boolean | null;
}

interface RouteTemplate {
  readonly method: string;
  readonly parts: readonly string[];
}

function isCypher(databaseType: string): boolean {
  return STATEMENT_LANGUAGE[databaseType] === "cypher";
}

function searchRead(sql: string): boolean | null {
  const read = readDevToolsRequest(embedProbeText(sql));
  if (read.kind === "sql") return null;
  if (read.kind === "invalid") return false;
  return devToolsAction(read.request) === "read";
}

function segments(path: string): string[] {
  const bare = path.split("?")[0]?.split("#")[0] ?? "";
  return bare.split("/").filter((part) => part !== "");
}

function templatesOf(spec: ConsoleDialectSpec, routes: readonly RouteSpec[]): RouteTemplate[] {
  return routes
    .filter((route) => route.class === "read" && spec.methods.includes(route.method))
    .flatMap((route) => {
      const prefixed = `${spec.pathPrefix}${route.template}`.replace(/\/{2,}/g, "/");
      const forms = [segments(prefixed)];
      if (spec.shortForm && route.template !== "") forms.push(segments(route.template));
      return forms.map((parts) => ({ method: route.method.toUpperCase(), parts }));
    });
}

function requestMatches(method: string, path: string, templates: readonly RouteTemplate[]): boolean {
  const got = segments(path);
  const verb = method.toUpperCase();
  return templates.some((template) => {
    if (template.method !== verb || template.parts.length !== got.length) return false;
    return template.parts.every((slot, index) => {
      if (slot.startsWith("{") && slot.endsWith("}")) return true;
      return got[index] === slot;
    });
  });
}

function commentLine(line: string): boolean {
  const trim = line.trim();
  return trim === "" || trim.startsWith("#") || trim.startsWith("//");
}

/** A console request the route table lists as a read, or null when the text is not a request. */
function consoleRead(sql: string, templates: readonly RouteTemplate[]): boolean | null {
  const lines = embedProbeText(sql)
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/);
  let index = 0;
  while (index < lines.length && commentLine(lines[index] ?? "")) index += 1;
  const requestLine = lines[index]?.trim() ?? "";
  if (requestLine === "") return null;
  const matched = /^(GET|POST|PUT|HEAD|DELETE)\s+(\S+)\s*$/i.exec(requestLine);
  if (matched === null) {
    return /^(GET|POST|PUT|HEAD|DELETE)\b/i.test(requestLine) ? false : null;
  }
  const method = matched[1] ?? "";
  const path = matched[2] ?? "";
  if (!requestMatches(method, path, templates)) return false;
  const body = lines
    .slice(index + 1)
    .filter((line) => !commentLine(line))
    .join("\n")
    .trim();
  if (body === "") return true;
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

const MILVUS_TEMPLATES = templatesOf(MILVUS_CONSOLE, MILVUS_ROUTES);
const QDRANT_TEMPLATES = templatesOf(QDRANT_CONSOLE, QDRANT_ROUTES);
const WEAVIATE_TEMPLATES = templatesOf(WEAVIATE_CONSOLE, WEAVIATE_ROUTES);

const SEARCH: Dialect = {
  rule: SEARCH_RULE,
  sample: SEARCH_SAMPLE,
  values: EMBEDDING_VALUES,
  read: searchRead,
};

const DIALECTS: Record<string, Dialect> = {
  opensearch: SEARCH,
  elasticsearch: SEARCH,
  milvus: {
    rule: `${VECTOR_EMBEDDING} ${milvusStatementLanguage()}`,
    sample: VECTOR_SAMPLE,
    values: EMBEDDING_VALUES,
    read: (sql) => consoleRead(sql, MILVUS_TEMPLATES),
  },
  qdrant: {
    rule: `${VECTOR_EMBEDDING} ${qdrantStatementLanguage(QDRANT_CONSOLE, QDRANT_ROUTES, QDRANT_REFUSED_CLASSES)}`,
    sample: VECTOR_SAMPLE,
    values: EMBEDDING_VALUES,
    read: (sql) => consoleRead(sql, QDRANT_TEMPLATES),
  },
  weaviate: {
    rule: `${VECTOR_EMBEDDING} ${weaviateStatementLanguage(WEAVIATE_CONSOLE, WEAVIATE_ROUTES, WEAVIATE_REFUSED_CLASSES)}`,
    sample: VECTOR_SAMPLE,
    values: EMBEDDING_VALUES,
    read: (sql) => consoleRead(sql, WEAVIATE_TEMPLATES),
  },
  airtable: {
    rule: "sql is one read-only SELECT or COUNT(*) from one table. No JOIN and no other aggregate. LIMIT pages the rows.",
    sample: SQL_SAMPLE,
    values: SQL_VALUES,
    read: () => null,
  },
  hubspot: {
    rule: "sql is one read-only SELECT or COUNT(*) from one CRM object. No JOIN. Do not rename columns.",
    sample: SQL_SAMPLE,
    values: SQL_VALUES,
    read: () => null,
  },
  stripe: {
    rule: 'sql is one read-only Stripe Sigma SELECT or WITH, or a report preview SELECT * FROM "reports"."name". This connection does not write.',
    sample: SQL_SAMPLE,
    values: SQL_VALUES,
    read: () => null,
  },
  clarity: {
    rule: "sql is one read-only SELECT or COUNT(*). Write WHERE days = 1, 2, or 3. At most three breakdown dimensions.",
    sample: SQL_SAMPLE,
    values: SQL_VALUES,
    read: () => null,
  },
  googleanalytics: {
    rule: "sql is one read-only SELECT. Dates are YYYY-MM-DD, today, yesterday, or NdaysAgo, written as startDate and endDate. They default to the last seven days.",
    sample: SQL_SAMPLE,
    values: SQL_VALUES,
    read: () => null,
  },
  quickbooks: {
    rule: "sql is one read-only SELECT or COUNT(*) of one entity. Combine filters with AND. Page with LIMIT.",
    sample: SQL_SAMPLE,
    values: SQL_VALUES,
    read: () => null,
  },
  odoo: {
    rule: "sql is one read-only SELECT or COUNT(*) of one model. Combine filters with AND. No JOIN.",
    sample: SQL_SAMPLE,
    values: SQL_VALUES,
    read: () => null,
  },
  supabase: {
    rule: "sql is one read-only Postgres statement for this engine.",
    sample: SQL_SAMPLE,
    values: SQL_VALUES,
    read: () => null,
  },
};

function dialectOf(databaseType: string): Dialect | null {
  return DIALECTS[databaseType] ?? null;
}

/** The sentence that tells the model what one statement is for this engine. */
export function assistStatementRule(databaseType: string): string {
  if (isCypher(databaseType)) return CYPHER_RULE;
  return dialectOf(databaseType)?.rule ?? SQL_RULE;
}

/** The sample sql field. It describes the statement and contains no quotes. */
export function assistSampleSql(databaseType: string): string {
  if (isCypher(databaseType)) return CYPHER_SAMPLE;
  return dialectOf(databaseType)?.sample ?? SQL_SAMPLE;
}

/** How values are written: chart filters, Cypher literals, or a vector embedding. */
export function assistValueRule(databaseType: string): string {
  if (isCypher(databaseType)) return CYPHER_VALUES;
  return dialectOf(databaseType)?.values ?? SQL_VALUES;
}

/** The extra sentence a follow-up needs when this engine is not plain SQL or Cypher. */
export function assistDialectNote(databaseType: string): string {
  if (isCypher(databaseType)) return "";
  return dialectOf(databaseType)?.rule ?? "";
}

/**
 * Whether this text is a native read for the engine.
 *
 * Null means it is not one of those requests, so the SQL or Cypher gate decides.
 * False means it is a request this chat must drop.
 */
export function assistNativeRead(databaseType: string, sql: string): boolean | null {
  return dialectOf(databaseType)?.read(sql) ?? null;
}
