import "../../setup-dom";

import { afterEach, describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { EmbeddingModelSelect } from "@/components/embeddings/EmbeddingModelSelect";
import { embeddingModelFor, setEmbeddingStorage, writeEmbeddingModel } from "@/lib/embeddings/settings";

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

describe("EmbeddingModelSelect", () => {
  afterEach(() => {
    cleanup();
  });

  test("stores a catalog model, a custom model, and a per-connection override", () => {
    setEmbeddingStorage(new MemoryStorage());
    const view = render(<EmbeddingModelSelect connectionId="orders" />);
    const select = view.getByLabelText("Embedding model") as HTMLSelectElement;
    expect(select.value).toBe("voyage-4");
    expect(view.getByText("Model: Voyage 4")).toBeTruthy();
    fireEvent.change(select, { target: { value: "voyage-4-lite" } });
    expect(view.getByText("Model: Voyage 4 lite")).toBeTruthy();
    expect(embeddingModelFor("orders")).toBe("voyage-4-lite");
    expect(embeddingModelFor("other")).toBe("voyage-4");

    fireEvent.change(select, { target: { value: "__custom__" } });
    expect(view.getByText("Model: Custom")).toBeTruthy();
    const input = view.getByLabelText("Custom embedding model") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "bad model" } });
    expect(view.getByText("Model: bad model")).toBeTruthy();
    expect(embeddingModelFor("orders")).toBe("voyage-4-lite");
    fireEvent.blur(input);
    expect(view.getByLabelText("Custom embedding model")).toBeTruthy();

    fireEvent.change(view.getByLabelText("Custom embedding model"), {
      target: { value: "text-embedding-3-small" },
    });
    fireEvent.blur(view.getByLabelText("Custom embedding model"));
    expect(embeddingModelFor("orders")).toBe("text-embedding-3-small");
    expect(view.getByText("Model: text-embedding-3-small")).toBeTruthy();

    fireEvent.change(view.getByLabelText("Custom embedding model"), { target: { value: "" } });
    fireEvent.blur(view.getByLabelText("Custom embedding model"));
    expect(embeddingModelFor("orders")).toBe("voyage-4");
    expect(view.queryByLabelText("Custom embedding model")).toBeNull();

    fireEvent.change(view.getByLabelText("Embedding model"), { target: { value: "__custom__" } });
    fireEvent.blur(view.getByLabelText("Custom embedding model"));
    expect(view.queryByLabelText("Custom embedding model")).toBeNull();

    writeEmbeddingModel("billing", "voyage-code-4");
    view.rerender(<EmbeddingModelSelect connectionId="billing" />);
    expect((view.getByLabelText("Embedding model") as HTMLSelectElement).value).toBe("voyage-code-4");
  });

  test("renders the default model where there is no browser storage", () => {
    const html = renderToString(<EmbeddingModelSelect />);
    expect(html).toContain("Voyage 4");
  });
});
