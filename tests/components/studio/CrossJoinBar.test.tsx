import "../../setup-dom";

import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { CrossJoinBar } from "@/components/studio/CrossJoinBar";
import { readJoinSizeChoice, setJoinSizeStorage } from "@/lib/saved-join/size-choice";
import type { SavedQuery } from "@/lib/types";

function query(tableId: string, sql: string): SavedQuery {
  return {
    id: tableId,
    name: tableId,
    tableId,
    query: sql,
    connectionType: "postgres",
    connectionId: "c1",
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

class MemoryStorage implements Storage {
  private readonly items = new Map<string, string>();
  get length(): number {
    return this.items.size;
  }
  clear(): void {
    this.items.clear();
  }
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.items.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.items.delete(key);
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
}

afterEach(() => {
  cleanup();
  setJoinSizeStorage(undefined);
});

describe("CrossJoinBar", () => {
  test("asks for two saved queries before it can write a join", () => {
    setJoinSizeStorage(new MemoryStorage());
    const view = render(<CrossJoinBar queries={[query("orders", "SELECT id FROM orders")]} onUse={() => {}} />);
    expect(view.getByText(/including one from the marketplace/)).toBeTruthy();
    expect(view.queryByRole("button", { name: "Use this join" })).toBeNull();
    const size = view.getByLabelText("DuckDB size") as HTMLSelectElement;
    expect(size.value).toBe("small");
    expect(size.options[0]?.text).toBe("Small - 256 MB, 1 thread");
    fireEvent.change(size, { target: { value: "large" } });
    expect(size.value).toBe("large");
    expect(readJoinSizeChoice()).toBe("large");
  });

  test("writes the join into the editor and follows the chosen queries", () => {
    const onUse = mock((sql: string) => sql);
    const view = render(
      <CrossJoinBar
        queries={[
          query("orders", "SELECT id, region FROM orders"),
          query("people", "SELECT id, name FROM people"),
          query("wide", "SELECT * FROM wide"),
        ]}
        onUse={onUse}
      />,
    );
    expect(view.queryByLabelText("DuckDB statement")).toBeNull();
    expect(view.getByText("Joins on id.")).toBeTruthy();
    const useJoin = () => {
      fireEvent.click(view.getByRole("button", { name: "Use this join" }));
      return onUse.mock.calls.at(-1)?.[0] ?? "";
    };
    expect(useJoin()).toContain('orders."id" = people."id"');
    expect(onUse).toHaveBeenCalledTimes(1);
    expect(onUse.mock.calls[0]?.[0]).toContain("INNER JOIN people");

    fireEvent.change(view.getByLabelText("Join"), { target: { value: "LEFT" } });
    expect(useJoin()).toContain("LEFT JOIN");
    fireEvent.change(view.getByLabelText("Join"), { target: { value: "RIGHT" } });
    expect(useJoin()).toContain("RIGHT JOIN");
    fireEvent.change(view.getByLabelText("Join"), { target: { value: "FULL" } });
    expect(useJoin()).toContain("FULL JOIN");
    fireEvent.change(view.getByLabelText("Join"), { target: { value: "INNER" } });
    expect(useJoin()).toContain("INNER JOIN");
    expect(view.queryByLabelText("DuckDB statement")).toBeNull();

    fireEvent.change(view.getByLabelText("Second query"), { target: { value: "wide" } });
    expect(view.getByText(/wide uses SELECT \*/)).toBeTruthy();
    fireEvent.change(view.getByLabelText("First query"), { target: { value: "people" } });
    fireEvent.change(view.getByLabelText("Second query"), { target: { value: "people" } });
    expect(view.getByText("Pick two different saved queries.")).toBeTruthy();
    expect(view.queryByRole("button", { name: "Use this join" })).toBeNull();
  });

  test("falls back when a chosen query is no longer saved", () => {
    const view = render(
      <CrossJoinBar
        queries={[query("orders", "SELECT id FROM orders"), query("people", "SELECT id FROM people")]}
        onUse={() => {}}
      />,
    );
    view.rerender(
      <CrossJoinBar
        queries={[query("invoices", "SELECT name FROM invoices"), query("ledger", "SELECT total FROM ledger")]}
        onUse={() => {}}
      />,
    );
    expect((view.getByLabelText("First query") as HTMLSelectElement).value).toBe("invoices");
    expect((view.getByLabelText("Second query") as HTMLSelectElement).value).toBe("ledger");
    expect(
      view.getByText("These queries do not share a column name. Finish the ON clause in the editor."),
    ).toBeTruthy();
  });
});
