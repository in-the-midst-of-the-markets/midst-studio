/**
 * The schema text AI Assist sends with a question.
 *
 * It reads the same catalog the editor does, then folds in the notes saved for
 * this connection. A connection that does not list its tables still sends those
 * notes. A failed read is a note on the page, not a thrown error.
 */

import type { DataDictionary } from "@/lib/data-dictionary";
import { applyDictionary } from "@/lib/data-dictionary";
import { sessionDefaultContainer } from "@/lib/db/container-walk";
import { detailedObjects, schemaContextOf } from "@/lib/db/detailed-object";
import { containerDepth, declaresCatalogSessions, relationKindIds } from "@/lib/db/object-kinds";
import type { Container, DatabaseObject, ObjectDetail, ProviderCapabilities } from "@/lib/db/types";
import { buildConnectionPayload } from "@/hooks/use-connection-payload";
import type { DatabaseConnection } from "@/lib/types";

export interface AssistSchema {
  readonly schemaContext: string;
  readonly note: string | null;
}

interface JsonResponse {
  readonly ok: boolean;
  readonly status: number;
  json: () => Promise<unknown>;
}

type Post = (path: string, init?: RequestInit) => Promise<JsonResponse>;

const EMPTY = "[]";

function noted(dictionary: DataDictionary | null, note: string | null, context = EMPTY): AssistSchema {
  return { schemaContext: applyDictionary(context, dictionary), note };
}

async function readBody(response: JsonResponse): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function messageFrom(body: unknown, fallback: string): string {
  if (body !== null && typeof body === "object" && "error" in body && typeof body.error === "string") {
    const text = body.error.trim();
    if (text !== "") return text;
  }
  return fallback;
}

function asContainers(body: unknown): Container[] {
  return Array.isArray(body) ? (body as Container[]) : [];
}

function capabilitiesOf(body: unknown): ProviderCapabilities | null {
  if (body === null || typeof body !== "object" || !("capabilities" in body)) return null;
  const capabilities = body.capabilities;
  if (capabilities === null || typeof capabilities !== "object") return null;
  return capabilities as ProviderCapabilities;
}

async function scopedContainers(
  post: (body: unknown) => Promise<JsonResponse>,
  payload: object,
): Promise<Container[] | undefined> {
  const top = await post(payload);
  if (!top.ok) return undefined;
  const defaultTop = sessionDefaultContainer(asContainers(await readBody(top)));
  if (defaultTop === undefined) return undefined;
  const children = await post({ ...payload, parent: defaultTop });
  if (!children.ok) return undefined;
  const listed = asContainers(await readBody(children));
  return listed.length === 0 ? undefined : listed;
}

/**
 * The schema JSON for one connection, plus a note when the catalog could not be read.
 * `post` is `appFetch` in the page and a fake in tests.
 */
export async function loadAssistSchema(
  connection: DatabaseConnection,
  dictionary: DataDictionary | null,
  post: Post,
  catalog: string | null,
): Promise<AssistSchema> {
  if (connection.skipObjectScan === true) {
    return noted(dictionary, "This connection does not list its tables. Notes you saved are still included.");
  }

  const payload = buildConnectionPayload(connection);
  const send = (path: string, body: unknown): Promise<JsonResponse> =>
    post(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  const meta = await send("/api/db/provider-meta", payload);
  const metaBody = await readBody(meta);
  if (!meta.ok)
    return { schemaContext: EMPTY, note: messageFrom(metaBody, `Could not read the database (${meta.status}).`) };

  const capabilities = capabilitiesOf(metaBody);
  if (capabilities === null) return { schemaContext: EMPTY, note: "The database did not describe itself." };

  let kinds: readonly string[];
  try {
    kinds = relationKindIds(capabilities);
  } catch (error) {
    return { schemaContext: EMPTY, note: error instanceof Error ? error.message : "Could not read the catalog." };
  }
  if (kinds.length === 0) return noted(dictionary, null);

  let containers: readonly (readonly string[])[] | undefined;
  if (declaresCatalogSessions(capabilities)) {
    const listed = await send("/api/db/objects/containers", payload);
    const listedBody = await readBody(listed);
    if (!listed.ok) return { schemaContext: EMPTY, note: messageFrom(listedBody, "Could not list databases.") };
    const catalogs = asContainers(listedBody);
    const names = catalogs.map((item) => item.name);
    const chosen = catalog !== null && names.includes(catalog) ? catalog : names[0];
    if (chosen === undefined) return noted(dictionary, "This server has no database to read.");
    const schemas = await send("/api/db/objects/containers", { ...payload, parent: [chosen] });
    const schemasBody = await readBody(schemas);
    if (!schemas.ok) return { schemaContext: EMPTY, note: messageFrom(schemasBody, "Could not list schemas.") };
    const schemaList = asContainers(schemasBody);
    if (schemaList.length > 0) containers = schemaList.map((item) => item.path);
  } else if (containerDepth(capabilities) === 2) {
    const scoped = await scopedContainers((body) => send("/api/db/objects/containers", body), payload);
    if (scoped !== undefined) containers = scoped.map((item) => item.path);
  }

  const inventory = await send("/api/db/objects/inventory", {
    ...payload,
    kinds,
    includeColumns: true,
    ...(containers === undefined ? {} : { containers }),
  });
  const inventoryBody = await readBody(inventory);
  if (!inventory.ok) {
    return { schemaContext: EMPTY, note: messageFrom(inventoryBody, "Could not read the tables.") };
  }
  if (inventoryBody === null || typeof inventoryBody !== "object" || !("objects" in inventoryBody)) {
    return { schemaContext: EMPTY, note: "The catalog could not be read." };
  }
  if (!Array.isArray(inventoryBody.objects)) return { schemaContext: EMPTY, note: "The catalog could not be read." };
  const details = "details" in inventoryBody && Array.isArray(inventoryBody.details) ? inventoryBody.details : [];
  const context = schemaContextOf(
    detailedObjects(inventoryBody.objects as DatabaseObject[], details as ObjectDetail[]),
  );
  return noted(dictionary, null, context);
}
