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
    const open = view.getByLabelText("Embedding model");
    expect(view.getByText("Model: Voyage 4")).toBeTruthy();
    expect(view.queryByRole("menu", { name: "Embedding models" })).toBeNull();

    fireEvent.click(open);
    fireEvent.click(open);
    expect(view.queryByRole("menu", { name: "Embedding models" })).toBeNull();
    fireEvent.click(open);
    fireEvent.click(view.getByRole("button", { name: "Close embedding model" }));
    expect(view.queryByRole("menu", { name: "Embedding models" })).toBeNull();

    fireEvent.click(open);
    const menu = view.getByRole("menu", { name: "Embedding models" });
    fireEvent.keyDown(menu, { key: "Enter" });
    expect(view.getByRole("menu", { name: "Embedding models" })).toBeTruthy();
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(view.queryByRole("menu", { name: "Embedding models" })).toBeNull();

    fireEvent.click(open);
    fireEvent.click(view.getByRole("menuitem", { name: "Voyage 4 lite" }));
    expect(view.getByText("Model: Voyage 4 lite")).toBeTruthy();
    expect(embeddingModelFor("orders")).toBe("voyage-4-lite");
    expect(embeddingModelFor("other")).toBe("voyage-4");
    expect(view.queryByRole("menu", { name: "Embedding models" })).toBeNull();

    fireEvent.click(open);
    fireEvent.click(view.getByRole("menuitem", { name: "Custom model" }));
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
    fireEvent.click(view.getByRole("button", { name: "Close embedding model" }));
    expect(view.queryByLabelText("Custom embedding model")).toBeNull();

    fireEvent.click(open);
    fireEvent.change(view.getByLabelText("Custom embedding model"), { target: { value: "" } });
    fireEvent.blur(view.getByLabelText("Custom embedding model"));
    expect(embeddingModelFor("orders")).toBe("voyage-4");
    expect(view.queryByLabelText("Custom embedding model")).toBeNull();
    expect(view.getByText("Model: Voyage 4")).toBeTruthy();

    fireEvent.click(view.getByRole("menuitem", { name: "Custom model" }));
    fireEvent.blur(view.getByLabelText("Custom embedding model"));
    expect(view.queryByLabelText("Custom embedding model")).toBeNull();

    writeEmbeddingModel("billing", "voyage-code-4");
    view.rerender(<EmbeddingModelSelect connectionId="billing" />);
    expect(view.getByText("Model: Voyage code 4")).toBeTruthy();
    expect(view.queryByRole("menu", { name: "Embedding models" })).toBeNull();
  });

  test("renders the default model where there is no browser storage", () => {
    const html = renderToString(<EmbeddingModelSelect />);
    expect(html).toContain("Voyage 4");
  });
});
