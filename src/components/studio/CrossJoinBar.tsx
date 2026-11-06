"use client";

import { useState, useSyncExternalStore, type ReactNode } from "react";
import { ChevronDown, Info } from "lucide-react";
import { crossDbJoinTables } from "@/lib/saved-join/connection";
import { crossJoinDraft, type CrossJoinKind } from "@/lib/saved-join/draft";
import { JOIN_SIZES } from "@/lib/saved-join/size";
import {
  includedJoinSize,
  readJoinSizeChoice,
  subscribeJoinSize,
  writeJoinSizeChoice,
} from "@/lib/saved-join/size-choice";
import { cn } from "@/lib/utils";
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

const SELECT_CLASS =
  "h-9 w-full appearance-none rounded-lg border border-hairline bg-control pl-3 pr-8 text-sm text-fg";

function SelectField({
  label,
  className,
  children,
}: {
  readonly label: string;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <label className={cn("flex min-w-0 flex-col gap-1.5 text-xs text-fg-muted", className)}>
      {label}
      <span className="relative block">
        {children}
        <ChevronDown
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-fg-muted"
        />
      </span>
    </label>
  );
}

function JoinSizeSelect() {
  const size = useSyncExternalStore(subscribeJoinSize, readJoinSizeChoice, includedJoinSize);
  return (
    <SelectField label="DuckDB size" className="min-w-52 flex-1">
      <select
        aria-label="DuckDB size"
        className={SELECT_CLASS}
        title="Memory and threads for this cross join"
        value={size}
        onChange={(event) => writeJoinSizeChoice(event.target.value)}
      >
        {JOIN_SIZES.map((option) => (
          <option key={option.id} value={option.id}>
            {option.name} - {option.detail}
          </option>
        ))}
      </select>
    </SelectField>
  );
}

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
      <div className="flex flex-wrap items-end gap-3 border-b border-hairline px-4 py-3">
        <JoinSizeSelect />
        <p className="pb-1.5 text-xs text-fg-secondary">
          Save a query on each database you want to combine, including one from the marketplace, and give it an ID. This
          DuckDB editor joins those IDs.
        </p>
      </div>
    );
  }
  const left = tables.find((table) => table.tableId === leftId) ?? tables[0];
  const right = tables.find((table) => table.tableId === rightId) ?? tables[1];
  const draft = crossJoinDraft(left, right, kind);
  const sql = draft.sql;
  return (
    <div className="flex flex-col gap-3 border-b border-hairline px-4 py-3">
      <div className="flex flex-wrap items-end gap-3">
        <JoinSizeSelect />
        <SelectField label="First query" className="min-w-40 flex-1">
          <select className={SELECT_CLASS} value={left.tableId} onChange={(event) => setLeftId(event.target.value)}>
            {tables.map((table) => (
              <option key={table.tableId} value={table.tableId}>
                {table.tableId}
              </option>
            ))}
          </select>
        </SelectField>
        <SelectField label="Join" className="w-28">
          <select className={SELECT_CLASS} value={kind} onChange={(event) => setKind(kindOf(event.target.value))}>
            {KINDS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </SelectField>
        <SelectField label="Second query" className="min-w-40 flex-1">
          <select className={SELECT_CLASS} value={right.tableId} onChange={(event) => setRightId(event.target.value)}>
            {tables.map((table) => (
              <option key={table.tableId} value={table.tableId}>
                {table.tableId}
              </option>
            ))}
          </select>
        </SelectField>
        {sql !== null && <UseJoinButton sql={sql} onUse={onUse} />}
      </div>
      <p className="flex items-start gap-1.5 text-xs text-fg-muted">
        <Info aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
        {draft.note}
      </p>
    </div>
  );
}

function UseJoinButton({ sql, onUse }: { sql: string; onUse: (sql: string) => void }) {
  return (
    <button
      type="button"
      className="h-9 shrink-0 rounded-lg bg-brand-solid px-4 text-sm font-medium text-white hover:bg-brand-solid-hover"
      onClick={() => onUse(sql)}
    >
      Use this join
    </button>
  );
}
