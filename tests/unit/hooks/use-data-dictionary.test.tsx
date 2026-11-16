import "../../setup-dom";

import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { useDataDictionary } from "@/hooks/use-data-dictionary";
import { emptyDictionary } from "@/lib/data-dictionary";
import { storage } from "@/lib/storage";

function Harness({ id }: { id: string | null }) {
  const { dictionary, save } = useDataDictionary(id);
  return (
    <div>
      <output>{dictionary.notes}</output>
      <button type="button" onClick={() => save({ ...dictionary, notes: "saved" })}>
        save
      </button>
    </div>
  );
}

describe("useDataDictionary", () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  test("a connection with no notes starts empty and a save is remembered", () => {
    const view = render(<Harness id="c1" />);
    expect(view.getByRole("status").textContent).toBe("");
    fireEvent.click(view.getByRole("button", { name: "save" }));
    expect(view.getByRole("status").textContent).toBe("saved");
    expect(storage.getDataDictionary("c1")?.notes).toBe("saved");
  });

  test("without a connection, saving does nothing", () => {
    const view = render(<Harness id={null} />);
    fireEvent.click(view.getByRole("button", { name: "save" }));
    expect(view.getByRole("status").textContent).toBe("");
    expect(storage.getDataDictionaries()).toEqual([]);
  });

  test("a storage event replaces the notes, and an unrelated event does not", () => {
    const view = render(<Harness id="c1" />);
    fireEvent.click(view.getByRole("button", { name: "save" }));

    const emit = (detail?: { collection: string; data?: unknown }): void => {
      act(() => {
        window.dispatchEvent(new CustomEvent("libredb-storage-change", detail === undefined ? undefined : { detail }));
      });
    };
    emit();
    emit({ collection: "history", data: [] });
    emit({ collection: "data_dictionaries", data: "nope" });
    expect(view.getByRole("status").textContent).toBe("saved");

    emit({ collection: "data_dictionaries", data: [] });
    expect(view.getByRole("status").textContent).toBe("");

    emit({
      collection: "data_dictionaries",
      data: [{ ...emptyDictionary("c1"), notes: "from the diagram" }],
    });
    expect(view.getByRole("status").textContent).toBe("from the diagram");
  });

  test("switching connections reads that connection's notes", () => {
    storage.saveDataDictionary({ ...emptyDictionary("c1"), notes: "one" });
    const view = render(<Harness id={null} />);
    view.rerender(<Harness id="c1" />);
    expect(view.getByRole("status").textContent).toBe("one");
    view.rerender(<Harness id="c2" />);
    expect(view.getByRole("status").textContent).toBe("");
  });
});
