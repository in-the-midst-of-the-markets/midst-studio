"use client";

import { useCallback, useEffect, useState } from "react";
import { emptyDictionary, type DataDictionary } from "@/lib/data-dictionary";
import { storage } from "@/lib/storage";

/**
 * The notes saved for one connection, kept in step with every other panel that writes them.
 *
 * The diagram and the sidebar notes editor can both be open. Each save dispatches
 * `libredb-storage-change`, and this hook applies that event, so a note written on a table
 * card shows up in the sidebar without a remount.
 */
export function useDataDictionary(connectionId: string | null): {
  dictionary: DataDictionary;
  setDictionary: (next: DataDictionary) => void;
  save: (next: DataDictionary) => void;
} {
  const read = (id: string | null): DataDictionary =>
    id === null ? emptyDictionary("") : (storage.getDataDictionary(id) ?? emptyDictionary(id));
  const [dictionary, setDictionary] = useState(() => read(connectionId));
  const [loadedFor, setLoadedFor] = useState(connectionId);
  if (loadedFor !== connectionId) {
    setLoadedFor(connectionId);
    setDictionary(read(connectionId));
  }

  useEffect(() => {
    if (connectionId === null || typeof window === "undefined") return;
    const onChange = (event: Event): void => {
      const detail = (event as CustomEvent<{ collection?: string; data?: unknown }>).detail;
      if (detail?.collection !== "data_dictionaries" || !Array.isArray(detail.data)) return;
      const found = (detail.data as DataDictionary[]).find((item) => item.connectionId === connectionId);
      setDictionary(found ?? emptyDictionary(connectionId));
    };
    window.addEventListener("libredb-storage-change", onChange);
    return () => window.removeEventListener("libredb-storage-change", onChange);
  }, [connectionId]);

  const save = useCallback(
    (next: DataDictionary): void => {
      if (connectionId === null) return;
      const stamped = { ...next, connectionId, updatedAt: new Date().toISOString() };
      storage.saveDataDictionary(stamped);
      setDictionary(stamped);
    },
    [connectionId],
  );

  return { dictionary, setDictionary, save };
}
