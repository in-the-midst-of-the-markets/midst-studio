import { afterEach, describe, expect, test } from "bun:test";
import { SAVED_JOIN_LIMITS } from "@/lib/saved-join/limits";
import { JOIN_SIZE_ERROR, limitsForJoinSize } from "@/lib/saved-join/size";
import {
  includedJoinSize,
  readJoinSizeChoice,
  setJoinSizeStorage,
  subscribeJoinSize,
  writeJoinSizeChoice,
} from "@/lib/saved-join/size-choice";

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
  setJoinSizeStorage(undefined);
});

describe("limitsForJoinSize", () => {
  test("an omitted size is the included budget", () => {
    expect(limitsForJoinSize(undefined)).toBe(SAVED_JOIN_LIMITS);
    expect(limitsForJoinSize("small")).toBe(SAVED_JOIN_LIMITS);
    expect(includedJoinSize()).toBe("small");
  });

  test("a named size raises memory, threads, time, and rows", () => {
    expect(limitsForJoinSize("medium")).toEqual({
      maxSourceRows: 50_000,
      maxResultRows: 50_000,
      memoryLimit: "1GB",
      threads: 2,
      timeoutMs: 30_000,
    });
    expect(limitsForJoinSize("large")).toMatchObject({ memoryLimit: "4GB", threads: 4, maxSourceRows: 200_000 });
  });

  test("anything else is refused", () => {
    expect(limitsForJoinSize("huge")).toBe(JOIN_SIZE_ERROR);
    expect(limitsForJoinSize("")).toBe(JOIN_SIZE_ERROR);
    expect(limitsForJoinSize(4)).toBe(JOIN_SIZE_ERROR);
    expect(limitsForJoinSize(null)).toBe(JOIN_SIZE_ERROR);
  });
});

describe("the browser's size choice", () => {
  test("remembers a size this server offers and ignores the rest", () => {
    const storage = new MemoryStorage();
    setJoinSizeStorage(storage);
    expect(readJoinSizeChoice()).toBe("small");
    expect(readJoinSizeChoice()).toBe("small");

    const heard = { count: 0 };
    const stop = subscribeJoinSize(() => {
      heard.count += 1;
    });
    writeJoinSizeChoice("large");
    expect(readJoinSizeChoice()).toBe("large");
    expect(storage.getItem("libredb_join_size")).toBe("large");
    expect(heard.count).toBe(1);

    writeJoinSizeChoice("unlimited");
    expect(readJoinSizeChoice()).toBe("large");
    expect(heard.count).toBe(1);
    stop();
    writeJoinSizeChoice("medium");
    expect(heard.count).toBe(1);
    expect(readJoinSizeChoice()).toBe("medium");
  });

  test("keeps the included size when the browser has no storage", () => {
    setJoinSizeStorage(null);
    expect(readJoinSizeChoice()).toBe("small");
    writeJoinSizeChoice("large");
    expect(readJoinSizeChoice()).toBe("small");
  });

  test("keeps the included size when storage throws or holds an unknown value", () => {
    const storage = new MemoryStorage();
    storage.getItem = () => {
      throw new Error("blocked");
    };
    setJoinSizeStorage(storage);
    expect(readJoinSizeChoice()).toBe("small");

    const refused = new MemoryStorage();
    refused.setItem = () => {
      throw new Error("full");
    };
    setJoinSizeStorage(refused);
    writeJoinSizeChoice("large");
    expect(readJoinSizeChoice()).toBe("small");

    const junk = new MemoryStorage();
    junk.setItem("libredb_join_size", "huge");
    setJoinSizeStorage(junk);
    expect(readJoinSizeChoice()).toBe("small");
    expect(readJoinSizeChoice()).toBe("small");
  });

  test("uses the page storage when no test storage is installed", () => {
    setJoinSizeStorage(undefined);
    localStorage.removeItem("libredb_join_size");
    expect(readJoinSizeChoice()).toBe("small");
    writeJoinSizeChoice("medium");
    expect(readJoinSizeChoice()).toBe("medium");
    localStorage.removeItem("libredb_join_size");
  });
});
