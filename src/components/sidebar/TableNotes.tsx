"use client";

import React, { useMemo, useState } from "react";
import type { DetailedObject } from "@/lib/db/detailed-object";
import { objectPathLabel, pathKey } from "@/lib/db/object-path";
import {
  emptyDictionary,
  liveTable,
  mergeDesign,
  noteColumnNames,
  noteForObject,
  parseSchemaDesign,
  type DataDictionary,
  type TableEndorsement,
  type TableNote,
} from "@/lib/data-dictionary";
import { storage } from "@/lib/storage";

interface TableNotesProps {
  readonly connectionId: string;
  readonly schema?: readonly DetailedObject[];
}

interface NoteRow {
  readonly path: readonly string[];
  readonly fromDesign: boolean;
  readonly note: TableNote;
}

const EMPTY_SCHEMA: readonly DetailedObject[] = [];

const ENDORSEMENTS: readonly { value: TableEndorsement; label: string }[] = [
  { value: "normal", label: "Normal" },
  { value: "endorsed", label: "Prefer" },
  { value: "excluded", label: "Exclude" },
];

function blank(path: readonly string[]): TableNote {
  return { path, description: "", endorsement: "normal", columns: {}, columnTypes: {}, relationships: [] };
}

/**
 * Hex-style notes for one connection: what each table is for, what a column's values
 * mean, and whether AI should prefer or avoid it. A schema design can be uploaded as
 * SQL, DBML, or JSON, including a snapshot from this app.
 */
export function TableNotes({ connectionId, schema = EMPTY_SCHEMA }: TableNotesProps) {
  const stored = storage.getDataDictionary(connectionId) ?? emptyDictionary(connectionId);
  const [dictionary, setDictionary] = useState<DataDictionary>(stored);
  const [loadedFor, setLoadedFor] = useState(connectionId);
  const [message, setMessage] = useState<string | null>(null);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");

  if (loadedFor !== connectionId) {
    setLoadedFor(connectionId);
    setDictionary(stored);
    setOpenKey(null);
    setMessage(null);
  }

  const persist = (next: DataDictionary): void => {
    const stamped = { ...next, connectionId, updatedAt: new Date().toISOString() };
    storage.saveDataDictionary(stamped);
    setDictionary(stamped);
  };

  const rows = useMemo((): NoteRow[] => {
    const listed: NoteRow[] = [];
    const seen = new Set<string>();
    for (const object of schema) {
      const key = pathKey(object.path);
      seen.add(key);
      const found = noteForObject(dictionary.tables, object, schema);
      listed.push({ path: object.path, fromDesign: false, note: found ?? blank(object.path) });
    }
    for (const note of dictionary.tables) {
      if (seen.has(pathKey(note.path))) continue;
      if (liveTable(schema, note.path) !== null) continue;
      listed.push({ path: note.path, fromDesign: true, note });
    }
    return listed;
  }, [dictionary.tables, schema]);

  const revised = (path: readonly string[], update: (note: TableNote) => TableNote): DataDictionary => {
    const object = schema.find((item) => pathKey(item.path) === pathKey(path));
    const found = object ? noteForObject(dictionary.tables, object, schema) : null;
    const current = found ?? dictionary.tables.find((note) => pathKey(note.path) === pathKey(path)) ?? blank(path);
    const nextNote = update({ ...current, path });
    const tables = dictionary.tables.filter(
      (note) => pathKey(note.path) !== pathKey(current.path) && pathKey(note.path) !== pathKey(path),
    );
    return { ...dictionary, tables: [...tables, nextNote] };
  };

  const write = (path: readonly string[], update: (note: TableNote) => TableNote): void => {
    persist(revised(path, update));
  };

  const onFile = async (event: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file === undefined) return;
    const text = await file.text();
    const parsed = parseSchemaDesign(text);
    if (!parsed.ok) {
      setMessage(parsed.error);
      return;
    }
    persist(mergeDesign(dictionary, connectionId, parsed.design));
    setMessage(
      parsed.design.tables.length === 1
        ? "Imported 1 table from the design."
        : `Imported ${parsed.design.tables.length} tables from the design.`,
    );
  };

  const addTable = (): void => {
    const parts = draftName
      .split(".")
      .map((part) => part.trim())
      .filter((part) => part !== "");
    if (parts.length === 0) return;
    write(parts, (note) => note);
    setDraftName("");
    setOpenKey(pathKey(parts));
  };

  return (
    <div data-testid="table-notes" className="flex h-full min-h-0 flex-col gap-3 overflow-auto px-3 py-2">
      <div>
        <h2 className="text-xs font-medium text-foreground">Table notes</h2>
        <p className="mt-1 text-[0.6875rem] leading-relaxed text-muted-foreground">
          Describe what a table is for, what a column&apos;s values look like, and which tables AI should prefer. These
          notes are sent with the schema. Upload a schema design as SQL, DBML, or JSON.
        </p>
      </div>
      <label className="block text-[0.6875rem] text-muted-foreground">
        Notes about this database
        <textarea
          aria-label="Notes about this database"
          value={dictionary.notes}
          onChange={(event) => setDictionary({ ...dictionary, notes: event.target.value })}
          onBlur={() => persist(dictionary)}
          rows={3}
          className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground"
        />
      </label>
      <div className="flex items-center gap-2">
        <label className="rounded-md border border-border px-2 py-1 text-[0.6875rem] text-foreground hover:bg-accent">
          Upload design
          <input
            data-testid="schema-design-file"
            type="file"
            accept=".sql,.ddl,.dbml,.json,application/json,text/plain"
            className="sr-only"
            onChange={(event) => void onFile(event)}
          />
        </label>
        {message !== null && <output className="text-[0.6875rem] text-muted-foreground">{message}</output>}
      </div>
      <form
        className="flex items-center gap-1"
        onSubmit={(event) => {
          event.preventDefault();
          addTable();
        }}
      >
        <input
          aria-label="Table to define"
          value={draftName}
          onChange={(event) => setDraftName(event.target.value)}
          placeholder="schema.table"
          className="h-7 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-xs"
        />
        <button type="submit" className="rounded-md bg-brand-solid px-2 py-1 text-[0.6875rem] text-white">
          Add
        </button>
      </form>
      {rows.length === 0 ? (
        <p className="text-[0.6875rem] text-muted-foreground">No tables yet. Add one, or upload a design.</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((row) => {
            const key = pathKey(row.path);
            const label = objectPathLabel(row.path);
            const open = openKey === key;
            return (
              <li key={key} className="rounded-md border border-border">
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() => setOpenKey(open ? null : key)}
                  className="flex w-full items-center justify-between gap-2 px-2 py-1.5 text-left text-xs"
                >
                  <span className="truncate font-medium">{label}</span>
                  <span className="shrink-0 text-[0.625rem] text-muted-foreground">
                    {row.fromDesign
                      ? "From the design"
                      : row.note.endorsement === "endorsed"
                        ? "Prefer"
                        : row.note.endorsement === "excluded"
                          ? "Exclude"
                          : "Notes"}
                  </span>
                </button>
                {open && (
                  <div className="space-y-2 border-t border-border px-2 py-2">
                    <label className="block text-[0.6875rem] text-muted-foreground">
                      How AI should use {label}
                      <select
                        aria-label={`How AI should use ${label}`}
                        value={row.note.endorsement}
                        onChange={(event) => {
                          const value = event.target.value;
                          const endorsement: TableEndorsement =
                            value === "endorsed" || value === "excluded" ? value : "normal";
                          write(row.path, (note) => ({ ...note, endorsement }));
                        }}
                        className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1 text-xs"
                      >
                        {ENDORSEMENTS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="block text-[0.6875rem] text-muted-foreground">
                      What {label} is for
                      <textarea
                        aria-label={`What ${label} is for`}
                        value={row.note.description}
                        onChange={(event) =>
                          setDictionary(revised(row.path, (note) => ({ ...note, description: event.target.value })))
                        }
                        onBlur={(event) => write(row.path, (note) => ({ ...note, description: event.target.value }))}
                        rows={3}
                        className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1 text-xs"
                      />
                    </label>
                    {noteColumnNames(row.note, schema).map((column) => (
                      <label key={column} className="block text-[0.6875rem] text-muted-foreground">
                        {column}
                        <input
                          aria-label={`Note for ${column}`}
                          value={row.note.columns[column] ?? ""}
                          onChange={(event) =>
                            setDictionary(
                              revised(row.path, (note) => ({
                                ...note,
                                columns: { ...note.columns, [column]: event.target.value },
                              })),
                            )
                          }
                          onBlur={(event) =>
                            write(row.path, (note) => ({
                              ...note,
                              columns: { ...note.columns, [column]: event.target.value },
                            }))
                          }
                          className="mt-1 h-7 w-full rounded-md border border-border bg-background px-2 text-xs"
                        />
                      </label>
                    ))}
                    {row.note.relationships.length > 0 && (
                      <ul className="text-[0.6875rem] text-muted-foreground">
                        {row.note.relationships.map((rel) => (
                          <li key={`${rel.fromColumn}-${rel.toTable}-${rel.toColumn}`}>
                            {rel.fromColumn} references {rel.toTable}.{rel.toColumn}
                          </li>
                        ))}
                      </ul>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        persist({
                          ...dictionary,
                          tables: dictionary.tables.filter((note) => pathKey(note.path) !== pathKey(row.note.path)),
                        });
                        setOpenKey(null);
                      }}
                      className="text-[0.6875rem] text-muted-foreground underline"
                    >
                      Clear notes
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
