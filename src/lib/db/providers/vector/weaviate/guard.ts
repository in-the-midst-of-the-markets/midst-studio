import { RequestRefusal } from "@/lib/db/console/dialect";
import { embedProbeText } from "@/lib/embeddings/placeholder";
import { parseWeaviateRequest, weaviatePhase0 } from "./request";

/**
 * The browser's verdict on a Weaviate console text: the grammar and every rule that needs neither the schema nor the
 * server, the same two functions the provider runs first, so what the editor refuses and what the server refuses for
 * those rules are one reading.
 *
 * A text it refuses is never sent to any route and never written to query history. The tenancy rule, the tenant's
 * status and a rule that reads the collection are the server's to apply.
 */

/** The operations that ask for a confirmation: none, because every route the console runs is a read. */
export const WEAVIATE_DESTRUCTIVE_OPERATIONS: ReadonlySet<string> = new Set<string>();

/** The sentence a statement is refused with, or undefined to send it. */
export function weaviateRefusal(text: string): string | undefined {
  try {
    // `{{text}}` in the vector value is not JSON until the server embeds it. The probe
    // lets the grammar read the request the run will send, and the text that is sent is still the original.
    weaviatePhase0(parseWeaviateRequest(embedProbeText(text)));
    return undefined;
  } catch (error) {
    if (error instanceof RequestRefusal) return error.message;
    throw error;
  }
}

/** What a text would run, for the confirmation gate: the class of its route, or undefined for a text the console refuses. */
export function readWeaviateOperations(text: string): readonly string[] | undefined {
  try {
    return [weaviatePhase0(parseWeaviateRequest(embedProbeText(text))).route.class];
  } catch (error) {
    if (error instanceof RequestRefusal) return undefined;
    throw error;
  }
}
