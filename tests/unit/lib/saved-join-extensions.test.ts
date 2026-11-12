import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { extensionsFor, joinExtensionFiles, resetJoinExtensionFiles } from "@/lib/saved-join/extensions";
import { openDuckDBClient } from "@/lib/db/providers/sql/duckdb/client";

describe("extensionsFor", () => {
  test("caches a gzip body and refuses a version or a platform it did not measure", async () => {
    const root = mkdtempSync(join(tmpdir(), "knowsql-ext-"));
    let calls = 0;
    const fetchBody = async () => {
      calls += 1;
      const zipped = gzipSync(Buffer.from("extension-bytes"));
      return { ok: true, arrayBuffer: async () => Uint8Array.from(zipped).buffer };
    };
    const first = await extensionsFor({
      version: "v1.5.6",
      platform: "linux_amd64",
      cacheRoot: root,
      fetch: fetchBody,
    });
    const second = await extensionsFor({
      version: "v1.5.6",
      platform: "linux_amd64",
      cacheRoot: root,
      fetch: fetchBody,
    });
    expect(calls).toBe(2);
    expect(first.signed).toEqual(second.signed);
    expect(await readFile(first.signed[0] as string, "utf8")).toBe("extension-bytes");
    expect(first.community).toHaveLength(1);

    const refused = await extensionsFor({
      version: "latest",
      platform: "../etc",
      cacheRoot: root,
      fetch: fetchBody,
    });
    expect(refused).toEqual({ signed: [], community: [] });

    const missing = await extensionsFor({
      version: "v1.5.6",
      platform: "linux_arm64",
      cacheRoot: root,
      fetch: async () => ({ ok: false, arrayBuffer: async () => new ArrayBuffer(0) }),
    });
    expect(missing).toEqual({ signed: [], community: [] });

    const broken = await extensionsFor({
      version: "v1.5.6",
      platform: "osx_arm64",
      cacheRoot: root,
      fetch: async () => {
        throw new Error("offline");
      },
    });
    expect(broken).toEqual({ signed: [], community: [] });

    const aborted = await extensionsFor({
      version: "v1.5.6",
      platform: "linux_amd64_abort",
      cacheRoot: root,
      signal: AbortSignal.abort(),
      fetch: async () => {
        throw new Error("should not fetch");
      },
    });
    expect(aborted).toEqual({ signed: [], community: [] });

    const plain = await extensionsFor({
      version: "v1.5.6",
      platform: "windows_amd64",
      cacheRoot: root,
      fetch: async () => ({ ok: true, arrayBuffer: async () => Uint8Array.from(Buffer.from("not gzip")).buffer }),
    });
    expect(plain).toEqual({ signed: [], community: [] });
    resetJoinExtensionFiles();
    await expect(
      joinExtensionFiles(undefined, async () => {
        throw new Error("no engine");
      }),
    ).rejects.toThrow("no engine");
    resetJoinExtensionFiles();
  });
});

describe("openDuckDBClient join extensions", () => {
  test("refuses a path that is not an extension file, and locks external access after a real load", async () => {
    await expect(
      openDuckDBClient(":memory:", {
        readOnly: false,
        joinExtensions: { signed: ["vss.duckdb_extension"], community: [] },
      }),
    ).rejects.toThrow("not a file this server can load");

    const files = await joinExtensionFiles();
    expect(files.signed).toHaveLength(1);
    expect(files.community).toHaveLength(1);
    const client = await openDuckDBClient(":memory:", { readOnly: false, joinExtensions: files });
    try {
      expect(client.loadedExtensions).toEqual(["vss", "duckpgq"]);
      const setting = await client.run("SELECT current_setting('enable_external_access') AS enabled");
      expect(setting.rows[0]?.enabled).toBe(false);
      await expect(client.run("SELECT * FROM read_text('/etc/hostname')")).rejects.toThrow(/disabled|Permission/i);
    } finally {
      client.close();
    }
  });
});
