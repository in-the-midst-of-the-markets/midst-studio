import { describe, expect, test } from "bun:test";
import {
  applyDictionary,
  emptyDictionary,
  liveTable,
  mergeDesign,
  noteColumnNames,
  noteForObject,
  parseSchemaDesign,
  type DataDictionary,
  type SchemaDesign,
  type TableNote,
} from "@/lib/data-dictionary";

function parsed(text: string): SchemaDesign {
  const result = parseSchemaDesign(text);
  if (!result.ok) throw new Error(result.error);
  return result.design;
}

function refused(text: string): string {
  const result = parseSchemaDesign(text);
  if (result.ok) throw new Error("expected the design to be refused");
  return result.error;
}

function note(path: string[], overrides: Partial<TableNote> = {}): TableNote {
  return {
    path,
    description: "",
    endorsement: "normal",
    columns: {},
    columnTypes: {},
    relationships: [],
    ...overrides,
  };
}

const users = { name: "users", path: ["public", "users"], columns: [{ name: "id" }, { name: "email" }] };
const orders = { name: "orders", path: ["public", "orders"], columns: [{ name: "id" }, { name: "status" }] };
const otherOrders = { name: "orders", path: ["sales", "orders"], columns: [{ name: "id" }] };

describe("parseSchemaDesign", () => {
  test("refuses an empty file, a huge file, and text that is not a design", () => {
    expect(refused("   ")).toContain("no tables");
    expect(refused("hello")).toContain("SQL");
    expect(refused("{not json")).toContain("SQL");
    expect(refused('{ "unrelated": true }')).toContain("not a schema design");
    expect(refused('{ "tables": [] }')).toContain("no tables");
    expect(refused("x".repeat(1_000_001))).toContain("too large");
  });

  test("reads a JSON dictionary, a column list, a snapshot, and a bare array", () => {
    const dictionary = parsed(
      JSON.stringify({
        notes: "Prefer orders.",
        tables: [
          {
            path: ["public", "orders"],
            description: "Paid orders",
            endorsement: "endorsed",
            columns: { status: "paid, refunded, pending" },
            relationships: [{ fromColumn: "customer_id", toTable: "public.customers", toColumn: "id" }],
          },
          { name: "public.customers", description: "  ", endorsement: "nope", columns: { id: "   " } },
          { name: "" },
          "skip",
          {
            name: "public.payments",
            columns: [
              { name: "id", type: "int", description: "key" },
              { name: " ", type: "int" },
              { description: "missing name" },
              "nope",
            ],
            relationships: [{ fromColumn: "id" }, { fromColumn: "", toTable: "t", toColumn: "id" }, "nope"],
          },
        ],
      }),
    );
    expect(dictionary.notes).toBe("Prefer orders.");
    expect(dictionary.tables[0].endorsement).toBe("endorsed");
    expect(dictionary.tables[0].columns.status).toBe("paid, refunded, pending");
    expect(dictionary.tables[0].relationships).toEqual([
      { fromColumn: "customer_id", toTable: "public.customers", toColumn: "id" },
    ]);
    expect(dictionary.tables[1].endorsement).toBe("normal");
    expect(dictionary.tables[1].columns).toEqual({});
    expect(dictionary.tables.map((table) => table.path.join("."))).toEqual([
      "public.orders",
      "public.customers",
      "public.payments",
    ]);
    expect(dictionary.tables[2].columnTypes.id).toBe("int");

    const snapshot = parsed(
      JSON.stringify({
        notes: "from a snapshot",
        schema: [
          {
            name: "orders",
            path: ["public", "orders"],
            columns: [{ name: "id", type: "integer" }, { type: "int" }, "x"],
          },
          { path: ["", "bad"] },
          "nope",
        ],
      }),
    );
    expect(snapshot.notes).toBe("from a snapshot");
    expect(snapshot.tables).toHaveLength(1);
    expect(snapshot.tables[0].columnTypes.id).toBe("integer");

    const listed = parsed(JSON.stringify([{ name: "solo" }, 4, { path: [1] }]));
    expect(listed.tables.map((table) => table.path)).toEqual([["solo"]]);

    expect(parsed('{ "notes": "only the jargon" }').notes).toBe("only the jargon");
    expect(parsed('{ "notes": "only the jargon" }').tables).toEqual([]);
  });

  test("keeps the first 300 tables and says so", () => {
    const tables = Array.from({ length: 301 }, (_, index) => ({ name: `t${index}` }));
    const design = parsed(JSON.stringify({ tables }));
    expect(design.tables).toHaveLength(300);
    expect(design.notes).toContain("first 300");
  });

  test("clips a very long description", () => {
    const design = parsed(JSON.stringify({ tables: [{ name: "t", description: "a".repeat(2005) }] }));
    expect(design.tables[0].description.endsWith("…")).toBe(true);
    expect(design.tables[0].description.length).toBe(2000);
  });

  test("reads SQL comments, keys, and comment-on statements", () => {
    const design = parsed(`
      -- Paid orders only.
      -- No internal staff.
      CREATE TABLE IF NOT EXISTS public.orders (
        id integer -- key, still
        PRIMARY KEY,
        status varchar(20) COMMENT 'paid, refunded, pending',
        customer_id integer REFERENCES public.customers (id), -- who bought it
        note text, -- free text
        code text DEFAULT 'it''s',
        label text COMMENT '   ',
        lone,
        "odd" text,
        CONSTRAINT orders_check CHECK (status <> 'it''s'),
        FOREIGN KEY (customer_id) REFERENCES public.customers (id),
        PRIMARY KEY (id)
      );
      CREATE TABLE -- qualified below
      public.side (id int);
      CREATE TABLE dangling (id int
      CREATE TABLE \`ticks\` (id int);
      CREATE TABLE [Boxes] (id int);
      CREATE TABLE public. (id int);
      CREATE TABLE /* never closed
      CREATE TABLE t AS SELECT 1;
      COMMENT ON TABLE public.orders IS 'it''s the paid ones';
      COMMENT ON COLUMN public.orders.status IS 'one of three';
      COMMENT ON TABLE missing IS 'nope';
      COMMENT ON TABLE public.orders not a quote;
      COMMENT ON TABLE 123 IS 'nope';
      COMMENT ON TABLE public.orders IS 'never
    `);
    const orders = design.tables.find((table) => table.path.join(".") === "public.orders");
    expect(orders?.description).toBe("it's the paid ones");
    expect(orders?.columns.status).toBe("one of three");
    expect(orders?.columns.customer_id).toBe("who bought it");
    expect(orders?.columns.note).toBe("free text");
    expect(orders?.columnTypes.status).toBe("varchar(20)");
    expect(orders?.relationships).toEqual([{ fromColumn: "customer_id", toTable: "public.customers", toColumn: "id" }]);
    expect(design.tables.map((table) => table.path[table.path.length - 1])).toContain("ticks");
    expect(design.tables.map((table) => table.path[table.path.length - 1])).toContain("Boxes");
  });

  test("a foreign key with several columns and one without a target column", () => {
    const design = parsed(`
      CREATE TABLE t (
        a int,
        b int,
        FOREIGN KEY (a, b) REFERENCES other (a, b),
        c int REFERENCES bare
      );
    `);
    expect(design.tables[0].relationships).toEqual([
      { fromColumn: "a", toTable: "other", toColumn: "a" },
      { fromColumn: "b", toTable: "other", toColumn: "a" },
    ]);
  });

  test("reads DBML notes, refs, and skips an indexes block", () => {
    const design = parsed(`
      Table public.orders {
        id integer [pk]
        status varchar [note: 'paid, refunded']
        amount decimal(10, 2)
        customer_id integer [ref: > public.customers.id]
        // ignored
        indexes {
          (status)
        }
        Note: 'Paid orders'
      }
      Table 
      Ref: public.orders.customer_id > public.customers.id
      Ref: nowhere
      Ref: only.one >
    `);
    expect(design.tables).toHaveLength(1);
    expect(design.tables[0].description).toBe("Paid orders");
    expect(design.tables[0].columns.status).toBe("paid, refunded");
    expect(design.tables[0].columnTypes.id).toBe("integer");
    expect(design.tables[0].columnTypes.amount).toBe("decimal(10, 2)");
    expect(design.tables[0].relationships).toEqual([
      { fromColumn: "customer_id", toTable: "public.customers", toColumn: "id" },
    ]);
  });
});

describe("mergeDesign", () => {
  test("keeps an existing note when the upload leaves it blank, and replaces a different connection", () => {
    const current: DataDictionary = {
      connectionId: "c1",
      notes: "keep me",
      updatedAt: "",
      tables: [
        note(["public", "orders"], {
          description: "already",
          endorsement: "endorsed",
          columns: { status: "old" },
          relationships: [{ fromColumn: "customer_id", toTable: "customers", toColumn: "id" }],
        }),
      ],
    };
    const merged = mergeDesign(current, "c1", {
      notes: "",
      tables: [note(["public", "orders"], { columns: { status: "new", id: "  " }, columnTypes: { id: "int" } })],
    });
    expect(merged.notes).toBe("keep me");
    expect(merged.tables[0].description).toBe("already");
    expect(merged.tables[0].endorsement).toBe("endorsed");
    expect(merged.tables[0].columns).toEqual({ status: "new" });
    expect(merged.tables[0].columnTypes.id).toBe("int");
    expect(merged.tables[0].relationships).toHaveLength(1);

    const replaced = mergeDesign(current, "c2", { notes: "other", tables: [] });
    expect(replaced.connectionId).toBe("c2");
    expect(replaced.notes).toBe("other");
    expect(replaced.tables).toEqual([]);
  });

  test("an uploaded exclusion replaces a preferred table", () => {
    const current = emptyDictionary("c1");
    const first = mergeDesign(current, "c1", {
      notes: "",
      tables: [note(["t"], { endorsement: "endorsed", description: "keep" })],
    });
    const second = mergeDesign(first, "c1", {
      notes: "now",
      tables: [
        note(["t"], { endorsement: "excluded", relationships: [{ fromColumn: "a", toTable: "b", toColumn: "c" }] }),
      ],
    });
    expect(second.tables[0].endorsement).toBe("excluded");
    expect(second.tables[0].description).toBe("keep");
    expect(second.notes).toBe("now");
    expect(second.tables[0].relationships).toHaveLength(1);
  });
});

describe("applyDictionary", () => {
  const schema = JSON.stringify([users, orders, otherOrders]);

  test("a missing or empty dictionary leaves the schema bytes alone", () => {
    expect(applyDictionary(schema, null)).toBe(schema);
    expect(applyDictionary(schema, emptyDictionary("c1"))).toBe(schema);
    expect(applyDictionary(schema, { ...emptyDictionary("c1"), tables: [note(["ghost"])] })).toBe(schema);
    expect(applyDictionary("not json", { ...emptyDictionary("c1"), notes: "x" })).toBe("not json");
    expect(applyDictionary("{}", { ...emptyDictionary("c1"), notes: "x" })).toBe("{}");
    expect(applyDictionary("[1]", { ...emptyDictionary("c1"), notes: "x" })).toBe("[1]");
  });

  test("folds a matching note, a bare name, and a design-only table", () => {
    const dictionary: DataDictionary = {
      ...emptyDictionary("c1"),
      notes: "Prefer orders.",
      tables: [
        note(["public", "orders"], {
          description: "Paid orders",
          endorsement: "endorsed",
          columns: { status: "paid or refunded", extra: "from the design" },
          columnTypes: { extra: "text", ghost: "int" },
          relationships: [{ fromColumn: "customer_id", toTable: "public.customers", toColumn: "id" }],
        }),
        note(["users"], { description: "Accounts", columns: { email: "lowercase" } }),
        note(["drafts"], { description: "Not loaded yet", endorsement: "excluded" }),
        note(["orders"]),
      ],
    };
    const applied = JSON.parse(applyDictionary(schema, dictionary)) as Array<Record<string, unknown>>;
    const paid = applied.find((item) => Array.isArray(item.path) && item.path.join(".") === "public.orders");
    expect(paid?.description).toBe("Paid orders");
    expect(paid?.endorsement).toBe("endorsed");
    expect(applied[0]?.dictionaryNotes).toBe("Prefer orders.");
    const columns = paid?.columns as Array<Record<string, unknown>>;
    expect(columns.find((column) => column.name === "status")?.description).toBe("paid or refunded");
    expect(columns.find((column) => column.name === "extra")?.designed).toBe(true);
    expect(columns.find((column) => column.name === "ghost")?.type).toBe("int");
    const accounts = applied.find((item) => item.name === "users");
    expect(accounts?.description).toBe("Accounts");
    const draft = applied.find((item) => item.name === "drafts");
    expect(draft?.designed).toBe(true);
    expect(draft?.endorsement).toBe("excluded");
    const sales = applied.find((item) => Array.isArray(item.path) && item.path[0] === "sales");
    expect(sales?.description).toBeUndefined();
  });

  test("notes on an empty schema become their own object", () => {
    const applied = JSON.parse(applyDictionary("[]", { ...emptyDictionary("c1"), notes: "just jargon" })) as Array<
      Record<string, unknown>
    >;
    expect(applied).toEqual([{ designed: true, name: "(notes)", dictionaryNotes: "just jargon", columns: [] }]);
  });

  test("a live column list that is not an array still gains the design's columns", () => {
    const applied = JSON.parse(
      applyDictionary(JSON.stringify([{ name: "t", path: ["t"], columns: "nope" }]), {
        ...emptyDictionary("c1"),
        tables: [note(["t"], { columns: { id: "key" } })],
      }),
    ) as Array<{ columns: Array<{ name: string }> }>;
    expect(applied[0].columns.map((column) => column.name)).toEqual(["id"]);

    const described = JSON.parse(
      applyDictionary(JSON.stringify([{ name: "t", path: ["t"], columns: "nope" }]), {
        ...emptyDictionary("c1"),
        tables: [note(["t"], { description: "only a description" })],
      }),
    ) as Array<{ description?: string; columns: string }>;
    expect(described[0].description).toBe("only a description");
    expect(described[0].columns).toBe("nope");

    const nameless = JSON.parse(
      applyDictionary(JSON.stringify([{}, { name: "" }]), { ...emptyDictionary("c1"), notes: "jargon" }),
    ) as Array<Record<string, unknown>>;
    expect(nameless[0].dictionaryNotes).toBe("jargon");
  });
});

describe("live tables", () => {
  const objects = [users, orders, otherOrders];

  test("an exact path wins, a unique bare name matches, and a shared name matches neither", () => {
    expect(liveTable(objects, ["public", "users"])).toBe(users);
    expect(liveTable(objects, ["users"])).toBe(users);
    expect(liveTable(objects, ["orders"])).toBeNull();
    expect(liveTable(objects, ["missing", "thing"])).toBeNull();
    expect(noteForObject([note(["users"], { description: "Accounts" })], users, objects)?.description).toBe("Accounts");
    expect(noteForObject([note(["orders"])], orders, objects)).toBeNull();
    expect(noteForObject([note(["public", "orders"], { description: "Paid" })], orders, objects)?.description).toBe(
      "Paid",
    );
  });

  test("column names are the live columns plus anything the design added", () => {
    expect(
      noteColumnNames(
        note(["public", "users"], { columns: { email: "x", extra: "y" }, columnTypes: { extra: "t", ghost: "int" } }),
        objects,
      ),
    ).toEqual(["id", "email", "extra", "ghost"]);
    expect(noteColumnNames(note(["draft"], { columns: { "": "skip", id: "key" } }), objects)).toEqual(["id"]);
  });
});
