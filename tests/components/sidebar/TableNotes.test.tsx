import "../../setup-dom";

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { render, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { emptyDictionary } from "@/lib/data-dictionary";
import type { DetailedObject } from "@/lib/db/detailed-object";
import { storage } from "@/lib/storage";
import { TableNotes } from "@/components/sidebar/TableNotes";

const column = (name: string) => ({ name, type: "text", nullable: true, isPrimary: false });

function table(name: string, path: readonly string[], columns: string[]): DetailedObject {
  return { name, kind: "table", path, columns: columns.map(column), indexes: [] };
}

const schema: DetailedObject[] = [
  table("users", ["public", "users"], ["id", "email"]),
  table("orders", ["public", "orders"], ["id"]),
  table("logs", ["public", "logs"], ["id"]),
];

function saved(): void {
  storage.saveDataDictionary({
    ...emptyDictionary("c1"),
    tables: [
      {
        path: ["users"],
        description: "Accounts",
        endorsement: "endorsed",
        columns: { email: "lowercase" },
        columnTypes: {},
        relationships: [],
      },
      {
        path: ["public", "logs"],
        description: "",
        endorsement: "excluded",
        columns: {},
        columnTypes: {},
        relationships: [],
      },
      {
        path: ["drafts"],
        description: "Not loaded",
        endorsement: "excluded",
        columns: {},
        columnTypes: {},
        relationships: [{ fromColumn: "id", toTable: "users", toColumn: "id" }],
      },
    ],
  });
}

async function upload(container: HTMLElement, name: string, text: string): Promise<void> {
  const input = container.querySelector('[data-testid="schema-design-file"]') as HTMLInputElement;
  const file = new File([text], name, { type: "text/plain" });
  fireEvent.change(input, { target: { files: [file] } });
}

describe("TableNotes", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  test("an empty connection offers an add and an upload", () => {
    const { getByText } = render(<TableNotes connectionId="c1" />);
    expect(getByText("No tables yet. Add one, or upload a design.")).toBeDefined();
  });

  test("lists live tables, a bare-name note, and a design-only table", () => {
    saved();
    const { getByRole } = render(<TableNotes connectionId="c1" schema={schema} />);
    expect(getByRole("button", { name: /public\.users/ }).textContent).toContain("Prefer");
    expect(getByRole("button", { name: /public\.orders/ }).textContent).toContain("Notes");
    expect(getByRole("button", { name: /public\.logs/ }).textContent).toContain("Exclude");
    expect(getByRole("button", { name: /drafts/ }).textContent).toContain("From the design");
  });

  test("edits a description, a column, and an endorsement, then clears them", () => {
    saved();
    const { getByRole, getByLabelText, queryByRole } = render(<TableNotes connectionId="c1" schema={schema} />);

    fireEvent.click(getByRole("button", { name: /public\.users/ }));
    const accounts = getByLabelText("What public.users is for");
    fireEvent.change(accounts, { target: { value: "Customer accounts" } });
    fireEvent.blur(accounts, { target: { value: "Customer accounts" } });
    fireEvent.click(getByRole("button", { name: /public\.users/ }));

    fireEvent.click(getByRole("button", { name: /public\.orders/ }));
    fireEvent.click(getByRole("button", { name: /public\.orders/ }));
    expect(queryByRole("textbox", { name: "What public.orders is for" })).toBeNull();
    fireEvent.click(getByRole("button", { name: /public\.orders/ }));

    const about = getByLabelText("What public.orders is for");
    fireEvent.change(about, { target: { value: "Paid orders" } });
    fireEvent.blur(about, { target: { value: "Paid orders" } });
    fireEvent.change(getByLabelText("How AI should use public.orders"), { target: { value: "endorsed" } });
    fireEvent.change(getByLabelText("How AI should use public.orders"), { target: { value: "nope" } });

    const id = getByLabelText("Note for id");
    fireEvent.change(id, { target: { value: "key" } });
    fireEvent.blur(id, { target: { value: "key" } });

    expect(storage.getDataDictionary("c1")?.tables.some((note) => note.description === "Paid orders")).toBe(true);
    expect(storage.getDataDictionary("c1")?.tables.some((note) => note.columns.id === "key")).toBe(true);

    fireEvent.click(getByRole("button", { name: "Clear notes" }));
    expect(storage.getDataDictionary("c1")?.tables.some((note) => note.path.join(".") === "public.orders")).toBe(false);
  });

  test("a design-only note keeps its relationship and can be cleared", () => {
    saved();
    const { getByRole, getByText, queryByRole } = render(<TableNotes connectionId="c1" schema={schema} />);
    fireEvent.click(getByRole("button", { name: /drafts/ }));
    expect(getByText("id references users.id")).toBeDefined();
    const about = getByRole("textbox", { name: "What drafts is for" });
    fireEvent.change(about, { target: { value: "Still a draft" } });
    fireEvent.blur(about, { target: { value: "Still a draft" } });
    fireEvent.click(getByRole("button", { name: "Clear notes" }));
    expect(queryByRole("button", { name: /drafts/ })).toBeNull();
  });

  test("saves database notes and adds a table by its dotted name", () => {
    const { getByLabelText, getByRole, getByText } = render(<TableNotes connectionId="c1" />);
    const notes = getByLabelText("Notes about this database");
    fireEvent.change(notes, { target: { value: "Prefer orders." } });
    fireEvent.blur(notes);
    expect(storage.getDataDictionary("c1")?.notes).toBe("Prefer orders.");

    fireEvent.click(getByRole("button", { name: "Add" }));
    expect(getByText("No tables yet. Add one, or upload a design.")).toBeDefined();

    fireEvent.change(getByLabelText("Table to define"), { target: { value: "  .  " } });
    fireEvent.click(getByRole("button", { name: "Add" }));
    expect(getByText("No tables yet. Add one, or upload a design.")).toBeDefined();

    fireEvent.change(getByLabelText("Table to define"), { target: { value: "  sales . invoices " } });
    fireEvent.click(getByRole("button", { name: "Add" }));
    expect(getByRole("button", { name: /sales\.invoices/ }).getAttribute("aria-expanded")).toBe("true");
  });

  test("imports a design file and reports a file it cannot read", async () => {
    const view = render(<TableNotes connectionId="c1" />);
    const input = view.getByTestId("schema-design-file");

    fireEvent.change(input, { target: { files: [] } });
    expect(view.queryByRole("status")).toBeNull();

    upload(view.container, "nope.txt", "hello");
    await waitFor(() => {
      expect(view.getByRole("status").textContent).toContain("SQL");
    });

    upload(view.container, "one.sql", "CREATE TABLE only_one (id int);");
    await waitFor(() => {
      expect(view.getByRole("status").textContent).toBe("Imported 1 table from the design.");
    });

    upload(view.container, "two.sql", "CREATE TABLE a (id int); CREATE TABLE b (id int);");
    await waitFor(() => {
      expect(view.getByRole("status").textContent).toBe("Imported 2 tables from the design.");
    });
    expect(storage.getDataDictionary("c1")?.tables.map((table) => table.path[0])).toEqual(["only_one", "a", "b"]);
  });

  test("switching connections drops the previous message", async () => {
    const view = render(<TableNotes connectionId="c1" />);
    upload(view.container, "one.sql", "CREATE TABLE only_one (id int);");
    await waitFor(() => {
      expect(view.getByRole("status")).toBeDefined();
    });
    view.rerender(<TableNotes connectionId="c2" />);
    expect(view.queryByRole("status")).toBeNull();
    expect(view.getByText("No tables yet. Add one, or upload a design.")).toBeDefined();
  });
});
