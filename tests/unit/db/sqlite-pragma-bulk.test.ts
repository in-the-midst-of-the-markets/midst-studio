import { describe, expect, test } from "bun:test";
import { sqliteBulkDetailStatements } from "@/lib/db/providers/sql/sqlite-pragma-bulk";

describe("sqliteBulkDetailStatements", () => {
  test("names the relation types and binds the schema after the target", () => {
    const open = sqliteBulkDetailStatements(["table", "virtual"], false);
    expect(open.target).toContain("t.type IN ('table', 'virtual')");
    expect(open.target).not.toContain("LIMIT ?");
    expect(open.columns).toContain("pragma_table_xinfo(d.object_name, ?)");
    expect(open.indexes).toContain("pragma_index_list(d.object_name, ?)");
    expect(open.indexColumns).toContain("pragma_index_info(l.index_name, ?)");
    expect(open.foreignKeys).toContain("pragma_foreign_key_list(d.object_name, ?)");
    expect(open.schemaBinds).toEqual([0, 1, 1, 2, 2]);
  });

  test("adds a bound limit when the folder is cut", () => {
    const cut = sqliteBulkDetailStatements(["view"], true);
    expect(cut.target).toContain("t.type IN ('view')");
    expect(cut.target).toContain("ORDER BY t.name\n         LIMIT ?");
    expect(cut.columns).toContain("LIMIT ?");
  });
});
