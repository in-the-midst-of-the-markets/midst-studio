/**
 * One schema for every connected database AI Assist may query.
 *
 * Each connection keeps the schema text it already builds. This joins them into
 * one list the model can name, and shortens that list to the size a question allows.
 */

import { ASSIST_SCHEMA_CAP } from "@/lib/ai/assist-plan";

interface AssistCatalogSource {
  readonly name: string;
  readonly engine: string;
  readonly schemaContext: string;
  readonly note: string | null;
}

interface AssistCatalog {
  readonly schemaContext: string;
  readonly notes: readonly string[];
  readonly byConnection: Readonly<Record<string, string>>;
}

interface CatalogDatabase {
  connection: string;
  engine: string;
  objects?: unknown[];
  note?: string;
}

const OMITTED = "Some tables were left out so this question would fit.";

function objectsOf(schemaContext: string): unknown[] | null {
  try {
    const parsed: unknown = JSON.parse(schemaContext);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function listed(source: AssistCatalogSource, notes: string[]): CatalogDatabase {
  if (source.note !== null && source.note.trim() !== "") notes.push(`${source.name}: ${source.note}`);
  const objects = objectsOf(source.schemaContext);
  if (objects === null) {
    return { connection: source.name, engine: source.engine, note: "The table list could not be read." };
  }
  return { connection: source.name, engine: source.engine, objects };
}

/** The engine named in the prompt. Empty when the connections do not share one. */
export function assistDatabaseType(engines: readonly string[]): string {
  const first = engines[0];
  if (first === undefined) return "";
  for (const engine of engines) {
    if (engine !== first) return "";
  }
  return first;
}

/** The schema JSON, the notes to show, and each connection's own schema text. */
export function composeAssistCatalog(
  sources: readonly (AssistCatalogSource & { readonly id: string })[],
): AssistCatalog {
  const notes: string[] = [];
  const databases = sources.map((source) => listed(source, notes));
  const byConnection: Record<string, string> = {};
  for (const source of sources) byConnection[source.id] = source.schemaContext;
  if (JSON.stringify(databases).length <= ASSIST_SCHEMA_CAP) {
    return { schemaContext: JSON.stringify(databases), notes, byConnection };
  }
  const trimmed = databases.map((database) => Object.assign({}, database));
  while (JSON.stringify(trimmed).length > ASSIST_SCHEMA_CAP) {
    let drop: CatalogDatabase | undefined;
    for (let index = trimmed.length - 1; index >= 0; index -= 1) {
      const database = trimmed[index];
      if (database !== undefined && database.objects !== undefined && database.objects.length > 0) {
        drop = database;
        break;
      }
    }
    if (drop === undefined) {
      notes.push("The connected databases did not fit in one question.");
      return { schemaContext: "[]", notes, byConnection };
    }
    drop.objects = [];
    drop.note = OMITTED;
    const line = `${drop.connection}: ${OMITTED}`;
    if (!notes.includes(line)) notes.push(line);
  }
  return { schemaContext: JSON.stringify(trimmed), notes, byConnection };
}

/**
 * Reads every connection. One that throws still leaves the others in the catalog.
 * `load` is `loadAssistSchema` on the page and a fake in tests.
 */
export async function loadAssistCatalog<
  T extends { readonly id: string; readonly name: string; readonly type: string },
>(
  connections: readonly T[],
  load: (connection: T) => Promise<{ readonly schemaContext: string; readonly note: string | null }>,
): Promise<AssistCatalog> {
  const sources = await Promise.all(
    connections.map(async (connection) => {
      try {
        const loaded = await load(connection);
        return {
          id: connection.id,
          name: connection.name,
          engine: connection.type,
          schemaContext: loaded.schemaContext,
          note: loaded.note,
        };
      } catch {
        return {
          id: connection.id,
          name: connection.name,
          engine: connection.type,
          schemaContext: "[]",
          note: "Could not read the database.",
        };
      }
    }),
  );
  return composeAssistCatalog(sources);
}
