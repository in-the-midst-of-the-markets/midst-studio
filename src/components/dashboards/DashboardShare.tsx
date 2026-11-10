"use client";

import { useCallback, useEffect, useState } from "react";
import { Link2 } from "lucide-react";
import { refreshDelayMs } from "@/lib/charts/chart-refresh";
import { appFetch, withBasePath } from "@/lib/config/base-path";
import type { DatabaseConnection, SavedChartConfig, SavedDashboard } from "@/lib/types";

interface FrozenNote {
  readonly chart: string;
  readonly reason: string;
}

interface DashboardShareProps {
  readonly dashboard: SavedDashboard;
  readonly charts: readonly SavedChartConfig[];
  readonly connections: readonly DatabaseConnection[];
  readonly onShareId: (shareId: string | null) => void;
}

function shareLink(shareId: string): string {
  return `${window.location.origin}${withBasePath(`/share/${shareId}`)}`;
}

function shortestRefresh(charts: readonly SavedChartConfig[]): number | null {
  let delay: number | null = null;
  for (const chart of charts) {
    const next = refreshDelayMs(chart.refreshSeconds);
    if (next === null) continue;
    delay = delay === null ? next : Math.min(delay, next);
  }
  return delay;
}

async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error !== "") return body.error;
  } catch {
    // The status line below is the answer when the body is not JSON.
  }
  return "The snapshot could not be saved.";
}

/**
 * Publish the open dashboard as a snapshot link, and keep that snapshot on the
 * same refresh interval as its charts.
 */
export function DashboardShare({ dashboard, charts, connections, onShareId }: DashboardShareProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [frozen, setFrozen] = useState<readonly FrozenNote[]>([]);
  const [copied, setCopied] = useState(false);
  const shareId = dashboard.shareId;

  const refresh = useCallback(
    async (force: boolean) => {
      if (dashboard.shareId === undefined) return;
      const response = await appFetch(`/api/share/${dashboard.shareId}/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force, connections }),
      });
      if (!response.ok) setError(await readError(response));
    },
    [connections, dashboard.shareId],
  );

  useEffect(() => {
    const delay = shortestRefresh(charts);
    if (shareId === undefined || delay === null) return;
    const id = window.setInterval(() => {
      void refresh(false);
    }, delay);
    return () => window.clearInterval(id);
  }, [charts, refresh, shareId]);

  const publish = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await appFetch("/api/share", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(shareId !== undefined ? { id: shareId } : {}),
          dashboard,
          charts,
          connections,
        }),
      });
      const body = (await response.json()) as { id?: unknown; error?: unknown; frozen?: unknown };
      if (!response.ok || typeof body.id !== "string") {
        setError(typeof body.error === "string" ? body.error : "The snapshot could not be saved.");
        return;
      }
      onShareId(body.id);
      setFrozen(Array.isArray(body.frozen) ? body.frozen.filter(isFrozenNote) : []);
      setCopied(false);
    } catch {
      setError("The snapshot could not be saved.");
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    if (shareId === undefined) return;
    setBusy(true);
    setError(null);
    try {
      const response = await appFetch(`/api/share/${shareId}`, { method: "DELETE" });
      if (!response.ok) {
        setError(await readError(response));
        return;
      }
      onShareId(null);
      setFrozen([]);
    } catch {
      setError("The snapshot could not be saved.");
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (shareId === undefined) return;
    try {
      await navigator.clipboard.writeText(shareLink(shareId));
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-lg border border-hairline bg-control px-2.5 py-1 text-xs font-medium text-fg"
      >
        <Link2 className="size-3.5" />
        Share
      </button>
      {open && (
        <dialog
          open
          aria-label="Share dashboard"
          className="fixed inset-0 z-50 m-0 flex h-full w-full max-w-none items-end justify-center border-0 bg-black/40 p-4 sm:items-center"
        >
          <div className="w-full max-w-lg rounded-xl border border-hairline bg-surface p-4 text-fg shadow-lg">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold">Share this dashboard</h2>
                <p className="mt-1 text-sm text-fg-muted">
                  Anyone with the link sees this dashboard. They do not get a login to the databases.
                </p>
              </div>
              <button type="button" onClick={() => setOpen(false)} className="text-sm text-fg-muted">
                Close
              </button>
            </div>
            {shareId !== undefined && (
              <div className="mt-4 flex gap-2">
                <input
                  aria-label="Share link"
                  readOnly
                  value={shareLink(shareId)}
                  className="min-w-0 flex-1 rounded-lg border border-hairline bg-canvas px-2 py-1.5 text-sm"
                />
                <button
                  type="button"
                  onClick={() => void copy()}
                  className="rounded-lg bg-brand-solid px-3 py-1.5 text-sm font-medium text-white"
                >
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
            )}
            {frozen.length > 0 && (
              <ul className="mt-3 list-disc pl-5 text-xs text-fg-muted">
                {frozen.map((note) => (
                  <li key={`${note.chart}-${note.reason}`}>
                    {note.chart}: {note.reason}
                  </li>
                ))}
              </ul>
            )}
            {error !== null && <p className="mt-3 text-sm text-danger">{error}</p>}
            <div className="mt-4 flex flex-wrap gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => void publish()}
                className="rounded-lg bg-brand-solid px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60"
              >
                {shareId === undefined ? "Create link" : "Update link"}
              </button>
              {shareId !== undefined && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void refresh(true)}
                  className="rounded-lg border border-hairline px-3 py-1.5 text-sm"
                >
                  Update data
                </button>
              )}
              {shareId !== undefined && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void stop()}
                  className="rounded-lg px-3 py-1.5 text-sm text-danger"
                >
                  Stop sharing
                </button>
              )}
            </div>
            <p className="mt-3 text-xs text-fg-muted">
              Charts with a refresh interval update the link on that schedule while this page is open, and whenever
              someone opens the link if the server is keeping your connections.
            </p>
          </div>
        </dialog>
      )}
    </>
  );
}

function isFrozenNote(value: unknown): value is FrozenNote {
  if (typeof value !== "object" || value === null) return false;
  const chart = "chart" in value ? value.chart : undefined;
  const reason = "reason" in value ? value.reason : undefined;
  return typeof chart === "string" && typeof reason === "string";
}
