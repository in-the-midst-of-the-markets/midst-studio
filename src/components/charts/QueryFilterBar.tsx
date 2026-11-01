"use client";

import { useState } from "react";
import type { QueryFilter } from "@/lib/charts/query-filters";

interface FilterControlProps {
  readonly filter: QueryFilter;
  readonly disabled: boolean;
  readonly onChange: (name: string, value: string) => void;
}

function FilterControl({ filter, disabled, onChange }: FilterControlProps) {
  const [draft, setDraft] = useState(filter.value);
  const [seen, setSeen] = useState(filter.value);
  if (seen !== filter.value) {
    setSeen(filter.value);
    setDraft(filter.value);
  }
  const commit = (value: string) => {
    if (value === filter.value) return;
    onChange(filter.name, value);
  };
  if (filter.options.length > 0) {
    const choices = filter.options.includes(filter.value) ? filter.options : [filter.value, ...filter.options];
    return (
      <label className="flex items-center gap-1 text-xs text-fg-muted">
        {filter.name}
        <select
          aria-label={filter.name}
          disabled={disabled}
          value={filter.value}
          onChange={(event) => commit(event.target.value)}
          className="rounded border border-hairline-strong bg-raised px-2 py-0.5 text-xs text-fg disabled:opacity-50"
        >
          {choices.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
    );
  }
  return (
    <label className="flex items-center gap-1 text-xs text-fg-muted">
      {filter.name}
      <input
        aria-label={filter.name}
        disabled={disabled}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => commit(draft)}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          commit(draft);
        }}
        className="w-28 rounded border border-hairline-strong bg-raised px-2 py-0.5 text-xs text-fg disabled:opacity-50"
      />
    </label>
  );
}

export interface QueryFilterBarProps {
  readonly filters: readonly QueryFilter[];
  readonly disabled?: boolean;
  readonly onChange: (name: string, value: string) => void;
}

/** The controls for the placeholders in the query behind this chart. */
export function QueryFilterBar({ filters, disabled = false, onChange }: QueryFilterBarProps) {
  return (
    <div className="flex flex-wrap gap-3 border-b border-hairline px-3 py-2" aria-label="Query filters">
      {filters.map((filter) => (
        <FilterControl key={filter.name} filter={filter} disabled={disabled} onChange={onChange} />
      ))}
    </div>
  );
}
