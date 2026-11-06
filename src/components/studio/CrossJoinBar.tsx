"use client";

import { useState } from "react";
import { crossDbJoinTables } from "@/lib/saved-join/connection";
import { crossJoinDraft, type CrossJoinKind } from "@/lib/saved-join/draft";
import type { SavedQuery } from "@/lib/types";

const KINDS: readonly { id: CrossJoinKind; label: string }[] = [
  { id: "INNER", label: "Inner" },
  { id: "LEFT", label: "Left" },
  { id: "RIGHT", label: "Right" },
  { id: "FULL", label: "Full" },
];

function kindOf(value: string): CrossJoinKind {
  if (value === "LEFT" || value === "RIGHT" || value === "FULL") return value;
  return "INNER";
}

const FIELD_CLASS = "mt-1 block h-8 rounded-lg border border-hairline bg-raised px-2 text-xs text-fg";

/**
 * Writes a DuckDB join of two saved queries into the editor.
 *
 * Shown only on Cross_DB_Joins. A marketplace database joins the same way once a query
 * saved on it has an ID: that ID is a table here.
 */
export function CrossJoinBar({ queries, onUse }: { queries: readonly SavedQuery[]; onUse: (sql: string) => void }) {
  const tables = crossDbJoinTables(queries);
  const [leftId, setLeftId] = useState(tables[0]?.tableId ?? "");
  const [rightId, setRightId] = useState(tables[1]?.tableId ?? "");
  const [kind, setKind] = useState<CrossJoinKind>("INNER");
  if (tables.length < 2) {
    return (
      <p className="border-b border-hairline px-4 py-2 text-xs text-fg-secondary">
        Save a query on each database you want to combine, including one from the marketplace, and give it an ID. This
        DuckDB editor joins those IDs.
      </p>
    );
  }
  const left = tables.find((table) => table.tableId === leftId) ?? tables[0];
  const right = tables.find((table) => table.tableId === rightId) ?? tables[1];
  const draft = crossJoinDraft(left, right, kind);
  const sql = draft.sql;
  return (
    <div className="flex flex-col gap-2 border-b border-hairline px-4 py-2">
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs text-fg-muted">
          First query
          <select className={FIELD_CLASS} value={left.tableId} onChange={(event) => setLeftId(event.target.value)}>
            {tables.map((table) => (
              <option key={table.tableId} value={table.tableId}>
                {table.tableId}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-fg-muted">
          Join
          <select className={FIELD_CLASS} value={kind} onChange={(event) => setKind(kindOf(event.target.value))}>
            {KINDS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-fg-muted">
          Second query
          <select className={FIELD_CLASS} value={right.tableId} onChange={(event) => setRightId(event.target.value)}>
            {tables.map((table) => (
              <option key={table.tableId} value={table.tableId}>
                {table.tableId}
              </option>
            ))}
          </select>
        </label>
        {sql !== null && <UseJoinButton sql={sql} onUse={onUse} />}
      </div>
      <p className="text-xs text-fg-secondary">{draft.note}</p>
      {sql !== null && (
        <pre aria-label="DuckDB statement" className="overflow-x-auto font-mono text-xs text-fg">
          {sql}
        </pre>
      )}
    </div>
  );
}

function UseJoinButton({ sql, onUse }: { sql: string; onUse: (sql: string) => void }) {
  return (
    <button
      type="button"
      className="h-8 rounded-lg bg-brand-solid px-3 text-xs font-medium text-white hover:bg-brand-solid-hover"
      onClick={() => onUse(sql)}
    >
      Use this join
    </button>
  );
}
