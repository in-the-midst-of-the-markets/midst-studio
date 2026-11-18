"use client";

import { useEffect, useRef } from "react";
import { appFetch } from "@/lib/config/base-path";
import { refreshDueCaches } from "@/lib/query-cache/run-refresh";
import type { DatabaseConnection } from "@/lib/types";

/** How often an open page looks for a cached table whose interval has elapsed. */
export const CACHE_SCHEDULE_POLL_MS = 15_000;

export interface QueryCacheScheduleProps {
  connections: readonly DatabaseConnection[];
  /** Called after a scheduled refresh replaces a table, so the open tree can reload. */
  onRefreshed?: () => void;
  /** Tests pass a short poll. An open page uses {@link CACHE_SCHEDULE_POLL_MS}. */
  intervalMs?: number;
}

/**
 * Rerun cached sources that are due, while this shell is open.
 *
 * The interval lives on the cache row. A closed page does not refresh, so a
 * source is not read when nobody is here. The next open catches up when the
 * last cache is older than the interval.
 */
export function QueryCacheSchedule({
  connections,
  onRefreshed,
  intervalMs = CACHE_SCHEDULE_POLL_MS,
}: QueryCacheScheduleProps): null {
  const connectionsRef = useRef(connections);
  const onRefreshedRef = useRef(onRefreshed);

  useEffect(() => {
    connectionsRef.current = connections;
    onRefreshedRef.current = onRefreshed;
  }, [connections, onRefreshed]);

  useEffect(() => {
    let stopped = false;
    let running = false;
    const tick = async (): Promise<void> => {
      if (running || stopped) return;
      running = true;
      try {
        const changed = await refreshDueCaches(connectionsRef.current, appFetch);
        if (changed && !stopped) onRefreshedRef.current?.();
      } catch {
        // A failed list leaves the tables as they are. The next tick tries again.
      } finally {
        running = false;
      }
    };
    const id = window.setInterval(() => void tick(), intervalMs);
    void tick();
    return () => {
      stopped = true;
      window.clearInterval(id);
    };
  }, [intervalMs]);

  return null;
}
