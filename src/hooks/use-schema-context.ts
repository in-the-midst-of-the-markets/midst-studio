"use client";

import { useEffect, useMemo, useState } from "react";
import { applyDictionary } from "@/lib/data-dictionary";
import { schemaContextOf, type DetailedObject } from "@/lib/db/detailed-object";
import { storage } from "@/lib/storage";

/**
 * The schema JSON the AI panels send.
 *
 * `schemaContextOf` is the catalog. A dictionary the user saved for this connection is
 * folded in on top of it, and a connection with no notes keeps the catalog's own bytes.
 */
export function useSchemaContext(schema: readonly DetailedObject[], connectionId: string | null): string {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const onChange = (event: Event): void => {
      const collection = (event as CustomEvent<{ collection?: string }>).detail?.collection;
      if (collection === "data_dictionaries") setRevision((current) => current + 1);
    };
    window.addEventListener("libredb-storage-change", onChange);
    return () => window.removeEventListener("libredb-storage-change", onChange);
  }, []);
  return useMemo(() => {
    const base = schemaContextOf(schema);
    if (connectionId === null) return base;
    // `revision` is the count of dictionary saves. It is read so the memo follows storage.
    return applyDictionary(base, revision < 0 ? null : storage.getDataDictionary(connectionId));
  }, [schema, connectionId, revision]);
}
