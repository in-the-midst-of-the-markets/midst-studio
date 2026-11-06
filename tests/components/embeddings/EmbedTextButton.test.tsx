import "../../setup-dom";

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { EmbedTextButton } from "@/components/embeddings/EmbedTextButton";
import { setEmbeddingIdStorage } from "@/lib/embeddings/ids";
import { setEmbeddingStorage } from "@/lib/embeddings/settings";

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

describe("EmbedTextButton", () => {
  afterEach(() => {
    cleanup();
    setEmbeddingIdStorage(undefined);
    setEmbeddingStorage(undefined);
  });

  test("asks for text and then shows the id for the WHERE clause", () => {
    setEmbeddingIdStorage(new MemoryStorage());
    setEmbeddingStorage(new MemoryStorage());
    const view = render(<EmbedTextButton connectionId="orders" />);
    fireEvent.click(view.getByRole("button", { name: "Embed" }));
    fireEvent.click(view.getByRole("button", { name: "Create id" }));
    expect(view.getByRole("alert").textContent).toContain("Enter the text");

    fireEvent.change(view.getByLabelText("Text to embed"), { target: { value: ` ${"a".repeat(4001)} ` } });
    fireEvent.click(view.getByRole("button", { name: "Create id" }));
    expect(view.getByRole("alert").textContent).toContain("4000");

    fireEvent.change(view.getByLabelText("Text to embed"), { target: { value: " cats " } });
    fireEvent.click(view.getByRole("button", { name: "Create id" }));
    expect(view.queryByRole("alert")).toBeNull();
    expect((view.getByLabelText("Embed id") as HTMLInputElement).value).toBe("{{embed e1}}");

    fireEvent.change(view.getByLabelText("Text to embed"), { target: { value: "dogs" } });
    fireEvent.click(view.getByRole("button", { name: "Create id" }));
    expect((view.getByLabelText("Embed id") as HTMLInputElement).value).toBe("{{embed e2}}");

    fireEvent.click(view.getByRole("button", { name: "Close" }));
    fireEvent.click(view.getByRole("button", { name: "Embed" }));
    expect(view.queryByLabelText("Embed id")).toBeNull();
  });

  test("stays closed until a connection is chosen", () => {
    const missing = render(<EmbedTextButton />);
    expect((missing.getByRole("button", { name: "Embed" }) as HTMLButtonElement).disabled).toBe(true);
    missing.unmount();
    const view = render(<EmbedTextButton connectionId="  " />);
    const button = view.getByRole("button", { name: "Embed" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });
});
