import { describe, expect, test } from "bun:test";
import { DatabaseConfigError } from "@/lib/db/errors";
import { SUPABASE_CONNECTION_STRING } from "@/lib/db/providers/sql/supabase/connection-string";
import { SUPABASE_SQL_GRAMMAR } from "@/lib/db/providers/sql/supabase/sql-grammar";
import { expandSupabaseHost, normalizeSupabaseConnection } from "@/lib/db/providers/sql/supabase/connection";
import { SupabaseProvider } from "@/lib/db/providers/sql/supabase";
import type { DatabaseConnection } from "@/lib/types";

const base = {
  id: "sb",
  name: "sb",
  type: "supabase",
  createdAt: new Date(0),
} as DatabaseConnection;

describe("Supabase host normalization", () => {
  test("expands a project ref, a project URL, and a dashboard URL", () => {
    expect(expandSupabaseHost("abcdefghij")).toBe("db.abcdefghij.supabase.co");
    expect(expandSupabaseHost("https://abcdefghij.supabase.co")).toBe("db.abcdefghij.supabase.co");
    expect(expandSupabaseHost("abcdefghij.supabase.co")).toBe("db.abcdefghij.supabase.co");
    expect(expandSupabaseHost("https://supabase.com/dashboard/project/abcdefghij/settings")).toBe(
      "db.abcdefghij.supabase.co",
    );
    expect(expandSupabaseHost("db.abcdefghij.supabase.co")).toBe("db.abcdefghij.supabase.co");
    expect(expandSupabaseHost("aws-0-us-east-1.pooler.supabase.com")).toBe("aws-0-us-east-1.pooler.supabase.com");
    expect(expandSupabaseHost("https://db.supabase.co")).toBe("https://db.supabase.co");
    expect(expandSupabaseHost("db.supabase.co")).toBe("db.supabase.co");
    expect(expandSupabaseHost("127.0.0.1")).toBe("127.0.0.1");
  });

  test("fills the Postgres defaults and turns TLS on for a Supabase host", () => {
    const normalized = normalizeSupabaseConnection({ ...base, host: "abcdefghij", ssl: { mode: "disable" } });
    expect(normalized).toMatchObject({
      host: "db.abcdefghij.supabase.co",
      port: 5432,
      user: "postgres",
      database: "postgres",
      ssl: { mode: "require" },
    });
  });

  test("keeps a pooler user, a set port, and a verify-full mode", () => {
    const normalized = normalizeSupabaseConnection({
      ...base,
      host: "aws-0-us-east-1.pooler.supabase.com",
      port: 6543,
      user: "postgres.abcdefghij",
      password: "secret",
      database: "app",
      ssl: { mode: "verify-full" },
    });
    expect(normalized).toMatchObject({
      host: "aws-0-us-east-1.pooler.supabase.com",
      port: 6543,
      user: "postgres.abcdefghij",
      database: "app",
      ssl: { mode: "verify-full" },
    });
  });

  test("reads a postgresql URL pasted into the host field", () => {
    const normalized = normalizeSupabaseConnection({
      ...base,
      host: "postgresql://owner:s%40cret@db.abcdefghij.supabase.co:6543/app",
      password: "ignored",
    });
    expect(normalized).toMatchObject({
      host: "db.abcdefghij.supabase.co",
      port: 6543,
      user: "owner",
      password: "s@cret",
      database: "app",
      ssl: { mode: "require" },
    });
  });

  test("leaves a saved connection string for the Postgres provider", () => {
    const normalized = normalizeSupabaseConnection({
      ...base,
      connectionString: "postgresql://postgres:secret@db.abcdefghij.supabase.co/postgres",
    });
    expect(normalized.connectionString).toContain("supabase.co");
    expect(normalized.host).toBeUndefined();
  });

  test("a URL without a user, password, database, or port keeps the fields already set", () => {
    const normalized = normalizeSupabaseConnection({
      ...base,
      host: "postgresql://db.abcdefghij.supabase.co",
      user: "owner",
      password: "secret",
      database: "app",
      port: 6543,
    });
    expect(normalized).toMatchObject({ user: "owner", password: "secret", database: "app", port: 6543 });
  });
});

describe("Supabase paste", () => {
  const paste = SUPABASE_CONNECTION_STRING.paste;
  if (paste === null) throw new Error("supabase paste is missing");

  test("claims a Supabase Postgres URL and no other Postgres URL", () => {
    expect(paste.claims("postgresql://postgres:pw@db.abcdefghij.supabase.co:5432/postgres")).toBe(true);
    expect(paste.names("POSTGRES://postgres@db.abcdefghij.supabase.co/postgres")).toBe(true);
    expect(paste.claims("postgresql://localhost/postgres")).toBe(false);
    expect(paste.parse("mysql://db.supabase.co")).toBeNull();
  });

  test("fills the fields and the TLS mode", () => {
    expect(paste.parse("postgresql://postgres:pw@db.abcdefghij.supabase.co:5432/postgres")).toMatchObject({
      type: "supabase",
      host: "db.abcdefghij.supabase.co",
      port: "5432",
      user: "postgres",
      password: "pw",
      database: "postgres",
      sslMode: "require",
    });
    expect(paste.parse("postgresql://db.abcdefghij.supabase.co/postgres?sslmode=verify-full")?.sslMode).toBe(
      "verify-full",
    );
    expect(paste.parse("postgresql://db.abcdefghij.supabase.co/postgres?sslmode=disable")?.sslMode).toBe("disable");
    expect(paste.parse("postgresql://db.abcdefghij.supabase.co/postgres?sslmode=verify-ca")?.sslMode).toBe("verify-ca");
    expect(paste.parse("postgresql://db.abcdefghij.supabase.co/postgres?sslmode=verify-system")?.sslMode).toBe(
      "verify-system",
    );
    expect(paste.parse("postgresql://db.abcdefghij.supabase.co/postgres?sslmode=prefer")?.unmappedTLSParam).toBe(
      "sslmode=prefer",
    );
    expect(paste.parse("postgresql://db.abcdefghij.supabase.co")?.database).toBeUndefined();
  });

  test("refuses a URL it cannot read", () => {
    expect(paste.parse("postgresql://a b.supabase.co")).toBeNull();
  });
});

describe("SupabaseProvider", () => {
  test("opens with the normalized host and without object edit", () => {
    const provider = new SupabaseProvider({ ...base, host: "abcdefghij", password: "secret" });
    expect(provider.config.host).toBe("db.abcdefghij.supabase.co");
    expect(provider.getCapabilities().defaultPort).toBe(5432);
    const editable = provider.getCapabilities().objectKinds?.filter((kind) => kind.acceptsSourceEdits === true);
    expect(editable).toEqual([]);
    expect(provider.getCapabilities().supportsTransactions).toBe(true);
  });

  test("names a missing host as Supabase", () => {
    expect(() => new SupabaseProvider({ ...base, host: "  " })).toThrow(DatabaseConfigError);
    try {
      new SupabaseProvider({ ...base, host: "" });
    } catch (error) {
      expect(error).toBeInstanceOf(DatabaseConfigError);
      expect(error instanceof Error ? error.message : "").toContain("project ref");
    }
  });

  test("requires an id", () => {
    expect(() => new SupabaseProvider({ ...base, id: "", host: "127.0.0.1" })).toThrow(/Connection ID is required/);
  });

  test("quotes a name the way Postgres does", () => {
    const format = SUPABASE_SQL_GRAMMAR.completion.formatSegment;
    expect(format).not.toBeNull();
    expect(format?.("orders")).toBe("orders");
    expect(format?.("select")).toBe('"select"');
    expect(format?.('a"b')).toBe('"a""b"');
  });
});
