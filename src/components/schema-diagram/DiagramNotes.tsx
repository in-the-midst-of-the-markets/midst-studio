"use client";

import type { DetailedObject } from "@/lib/db/detailed-object";
import { objectPathLabel } from "@/lib/db/object-path";
import {
  noteColumnNames,
  noteForObject,
  removeRelationshipNote,
  replaceTableNote,
  withoutTableNote,
  type DataDictionary,
  type TableEndorsement,
  type TableNote,
} from "@/lib/data-dictionary";

interface DiagramNotesProps {
  readonly table: DetailedObject;
  readonly schema: readonly DetailedObject[];
  readonly dictionary: DataDictionary;
  readonly onDraft: (next: DataDictionary) => void;
  readonly onSave: (next: DataDictionary) => void;
}

const ENDORSEMENTS: readonly { value: TableEndorsement; label: string }[] = [
  { value: "normal", label: "Normal" },
  { value: "endorsed", label: "Prefer" },
  { value: "excluded", label: "Exclude" },
];

const EMPTY_NOTE: TableNote = {
  path: [],
  description: "",
  endorsement: "normal",
  columns: {},
  columnTypes: {},
  relationships: [],
};

/**
 * The same table notes the sidebar saves, written on the table that is selected in the diagram.
 * A description, a column note, and a relationship all go into that connection's dictionary.
 */
export function DiagramNotes({ table, schema, dictionary, onDraft, onSave }: DiagramNotesProps) {
  const label = objectPathLabel(table.path);
  const found = noteForObject(dictionary.tables, table, schema);
  const current = found ?? { ...EMPTY_NOTE, path: table.path };
  const draft = (update: (note: TableNote) => TableNote): void => {
    onDraft(replaceTableNote(dictionary, schema, table.path, update));
  };
  const commit = (update: (note: TableNote) => TableNote): void => {
    onSave(replaceTableNote(dictionary, schema, table.path, update));
  };

  return (
    <div className="max-h-64 space-y-2 overflow-auto border-t border-hairline pt-2">
      <p className="text-[0.625rem] leading-relaxed text-fg-muted">
        Notes on {label} are saved with this connection and sent to AI with the schema.
      </p>
      <label className="block text-[0.6875rem] text-fg-muted">
        How AI should use it
        <select
          aria-label={`How the diagram marks ${label}`}
          value={current.endorsement}
          onChange={(event) => {
            const value = event.target.value;
            const endorsement: TableEndorsement = value === "endorsed" || value === "excluded" ? value : "normal";
            commit((note) => ({ ...note, endorsement }));
          }}
          className="mt-1 w-full rounded border border-hairline-strong bg-fill px-2 py-1 text-xs text-fg-secondary"
        >
          {ENDORSEMENTS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <label className="block text-[0.6875rem] text-fg-muted">
        What this table is for
        <textarea
          aria-label={`Diagram note for ${label}`}
          value={current.description}
          onChange={(event) => draft((note) => ({ ...note, description: event.target.value }))}
          onBlur={(event) => commit((note) => ({ ...note, description: event.target.value }))}
          rows={3}
          className="mt-1 w-full rounded border border-hairline-strong bg-fill px-2 py-1 text-xs text-fg-secondary"
        />
      </label>
      {noteColumnNames(current, schema).map((column) => (
        <label key={column} className="block text-[0.6875rem] text-fg-muted">
          {column}
          <input
            aria-label={`Diagram note for ${label}.${column}`}
            value={current.columns[column] ?? ""}
            onChange={(event) =>
              draft((note) => ({ ...note, columns: { ...note.columns, [column]: event.target.value } }))
            }
            onBlur={(event) =>
              commit((note) => ({ ...note, columns: { ...note.columns, [column]: event.target.value } }))
            }
            className="mt-1 h-7 w-full rounded border border-hairline-strong bg-fill px-2 text-xs text-fg-secondary"
          />
        </label>
      ))}
      {current.relationships.length > 0 && (
        <ul className="space-y-1 text-[0.6875rem] text-fg-muted">
          {current.relationships.map((rel) => {
            const text = `${rel.fromColumn} references ${rel.toTable}.${rel.toColumn}`;
            return (
              <li key={text} className="flex items-center justify-between gap-2">
                <span className="truncate">{text}</span>
                <button
                  type="button"
                  onClick={() => onSave(removeRelationshipNote(dictionary, schema, table.path, rel))}
                  className="shrink-0 text-fg-subtle underline hover:text-fg-tertiary"
                >
                  Remove
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <button
        type="button"
        onClick={() => onSave(withoutTableNote(dictionary, schema, table.path))}
        className="text-[0.6875rem] text-fg-subtle underline hover:text-fg-tertiary"
      >
        Clear notes on this table
      </button>
    </div>
  );
}
