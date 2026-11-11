import { describe, expect, test } from "bun:test";
import { DatabaseConfigError, QueryError } from "@/lib/db/errors";
import { pipedriveHost, readPipedriveToken } from "@/lib/db/providers/sql/pipedrive/auth";
import { PIPEDRIVE_SQL_GRAMMAR } from "@/lib/db/providers/sql/pipedrive/sql-grammar";
import {
  PIPEDRIVE_ROW_CAP,
  pipedriveRows,
  translatePipedriveSql,
  type PipedriveSelect,
} from "@/lib/db/providers/sql/pipedrive/translate";
import type { DatabaseConnection } from "@/lib/types";

const base = {
  id: "pd",
  name: "pd",
  type: "pipedrive",
  host: "",
  user: "",
  database: "",
  password: "api-token-value",
  createdAt: new Date(0),
} as DatabaseConnection;

function select(sql: string): PipedriveSelect {
  return translatePipedriveSql(sql);
}

describe("Pipedrive SQL", () => {
  test("reads one resource, then filters and pages the answer", () => {
    const deal = select(
      "SELECT deal.title, deal.value FROM deal WHERE deal.status = 'open' AND deal.title LIKE '%a.c%' AND deal.value > 10 ORDER BY deal.value DESC LIMIT 100",
    );
    expect(deal.resource.path).toBe("/api/v2/deals");
    expect(deal.columns).toEqual(["deal.title", "deal.value"]);
    const rows = pipedriveRows(
      deal,
      [
        { id: 1, title: "a.c", status: "open", value: 12 },
        { id: 2, title: "axc", status: "open", value: 20 },
        { id: 3, title: "a.c", status: "won", value: 30 },
        { id: 4, title: "a.c", status: "open", value: "nope" },
      ],
      deal.resource.path,
    );
    expect(rows.map((row) => row["deal.title"])).toEqual(["a.c"]);

    const star = select("SELECT * FROM deal");
    expect(star.columns).toBeNull();
    expect(
      pipedriveRows(star, [{ id: 9, title: "Brand", value: 12.5, custom_fields: { a: 1 } }], "sql")[0],
    ).toMatchObject({
      "deal.id": 9,
      "deal.title": "Brand",
      "deal.value": 12.5,
    });

    expect(select("SELECT person.name FROM person").resource.path).toBe("/api/v2/persons");
    expect(select("SELECT organization.name FROM organization").resource.path).toBe("/api/v2/organizations");
    expect(select("SELECT activity.subject FROM activity WHERE activity.done = 'true'").resource.path).toBe(
      "/api/v2/activities",
    );
    const done = pipedriveRows(
      select("SELECT activity.subject FROM activity WHERE activity.done = 'true' AND activity.due_date IS NOT NULL"),
      [
        { id: 1, subject: "Call", done: true, due_date: "2026-01-01" },
        { id: 2, subject: "Later", done: false },
      ],
      "sql",
    );
    expect(done).toHaveLength(1);
    expect(select("SELECT product.name FROM product").resource.path).toBe("/api/v2/products");
    expect(select("SELECT pipeline.name FROM pipeline").resource.path).toBe("/api/v2/pipelines");
    expect(select("SELECT stage.name FROM stage WHERE stage.pipeline_id = 3").resource.path).toBe("/api/v2/stages");

    const decimal = select("SELECT deal.id FROM deal WHERE deal.value = 1.5 AND deal.value = -1");
    expect(pipedriveRows(decimal, [{ id: 1, value: 1.5 }], "sql")).toEqual([]);
    const objectTitle = select("SELECT deal.id FROM deal WHERE deal.title = 'x'");
    expect(
      pipedriveRows(
        objectTitle,
        [
          { id: 1, title: null },
          { id: 2, title: { a: 1 } },
        ],
        "sql",
      ),
    ).toEqual([]);
    const bounds = select(
      "SELECT deal.title FROM deal WHERE deal.title != 'A' AND deal.title <> 'B' AND deal.title > 'C' AND deal.title >= 'M' AND deal.title <= 'Z' ORDER BY deal.title ASC",
    );
    expect(
      pipedriveRows(
        bounds,
        [
          { id: 1, title: "C" },
          { id: 2, title: "M" },
          { id: 3, title: "Z" },
        ],
        "sql",
      ).map((row) => row["deal.title"]),
    ).toEqual(["M", "Z"]);

    const numbers = select(
      "SELECT deal.id FROM deal WHERE deal.value < 5 AND deal.value <= 4 AND deal.value >= 1 AND deal.id != 9",
    );
    expect(
      pipedriveRows(
        numbers,
        [
          { id: 2, value: 4 },
          { id: 9, value: 1 },
        ],
        "sql",
      ),
    ).toHaveLength(1);

    const quoted = select("SELECT \"deal.title\" FROM deal WHERE deal.title = 'O''Brien' -- note\n /* block */ ;");
    expect(pipedriveRows(quoted, [{ id: 1, title: "O'Brien" }], "sql")).toHaveLength(1);

    const unknownFilter = {
      ...select("SELECT deal.id FROM deal"),
      filters: [{ field: "deal.nope", operator: "=" as const, value: "1" }],
    };
    expect(pipedriveRows(unknownFilter, [{ id: 1 }], "sql")).toEqual([]);
    const unknownOrder = { ...select("SELECT deal.id FROM deal"), orderBy: { column: "deal.nope", desc: false } };
    expect(pipedriveRows(unknownOrder, [{ id: 2 }, { id: 1 }], "sql").map((row) => row["deal.id"])).toEqual([2, 1]);

    const mixed = select("SELECT deal.id FROM deal ORDER BY deal.id ASC");
    const mixedRows = pipedriveRows(mixed, [{ id: { a: 1 } }, { id: 2 }, { id: null }], "sql");
    expect(mixedRows[2]?.["deal.id"]).toBeNull();

    const capped = select("SELECT deal.id FROM deal LIMIT 5000 OFFSET 20");
    expect(capped.limit).toBe(PIPEDRIVE_ROW_CAP);
    expect(capped.capped).toBe(true);

    const format = PIPEDRIVE_SQL_GRAMMAR.completion.formatSegment;
    const read = PIPEDRIVE_SQL_GRAMMAR.completion.readQuotedQualifier;
    expect(format?.('a"b')).toBe('"a""b"');
    expect(read?.('"de""al".')).toBe('de"al');
    expect(PIPEDRIVE_SQL_GRAMMAR.grammar.completionWords?.lists).toBe("only");
    expect(PIPEDRIVE_SQL_GRAMMAR.completion.nameIsDottedWord).toBe(true);
    expect(PIPEDRIVE_SQL_GRAMMAR.readsSqlText).toBe(true);
  });

  test("refuses a statement the API cannot run", () => {
    const refused = [
      "",
      "DELETE FROM deal",
      "SELECT DISTINCT deal.id FROM deal",
      "SELECT COUNT(*) FROM deal",
      "SELECT deal.missing FROM deal",
      "SELECT deal.id FROM missing",
      "SELECT deal.id FROM deal WHERE deal.status = 'open' OR deal.status = 'won'",
      "SELECT deal.id FROM deal WHERE deal.value LIKE '%1%'",
      "SELECT deal.id FROM deal WHERE deal.status = open",
      "SELECT deal.id FROM deal WHERE deal.title IS NOT",
      "SELECT deal.id FROM deal WHERE deal.title IS GONE",
      "SELECT deal.id FROM deal ORDER deal.title",
      "SELECT deal.id FROM deal ORDER BY deal.title, deal.value",
      "SELECT deal.id FROM deal LIMIT 0",
      "SELECT deal.id FROM deal LIMIT -1",
      "SELECT deal.id FROM deal OFFSET -1",
      "SELECT deal.id FROM deal LIMIT 9999999999999999999",
      "SELECT deal.id FROM deal; SELECT deal.id FROM deal",
      "SELECT deal.id FROM deal /*",
      "SELECT deal.id FROM deal WHERE deal.title = 'open",
      'SELECT deal.id FROM deal WHERE deal.title = "open',
      "SELECT deal.id FROM deal WHERE deal.title = !",
      "SELECT deal.id FROM deal WHERE deal.status IN ('open')",
      "SELECT 1 FROM deal",
      "SELECT deal.id FROM deal WHERE deal.title = @",
      'SELECT "de""al.title" FROM deal',
      "SELECT deal.id FROM",
      "SELECT deal.id",
    ];
    for (const sql of refused) {
      expect(() => translatePipedriveSql(sql)).toThrow(QueryError);
    }
    expect(() => pipedriveRows(select("SELECT deal.id FROM deal"), ["nope"], "sql")).toThrow(QueryError);
  });

  test("accepts the API host and a pasted token, and refuses the rest", () => {
    expect(pipedriveHost({ ...base, host: "" })).toBe("api.pipedrive.com");
    expect(pipedriveHost({ ...base, host: " https://Acme.pipedrive.com. " })).toBe("acme.pipedrive.com");
    expect(pipedriveHost({ ...base, host: "api.pipedrive.com/v1" })).toBe("api.pipedrive.com");
    expect(readPipedriveToken("  api-token-value  ")).toBe("api-token-value");
    const evil = "https://evil.example/token";
    expect(() => pipedriveHost({ ...base, host: evil })).toThrow(DatabaseConfigError);
    try {
      pipedriveHost({ ...base, host: evil });
    } catch (error) {
      expect((error as Error).message).not.toContain("evil.example");
      expect((error as Error).message).not.toContain("api-token-value");
    }
    expect(() => pipedriveHost({ ...base, host: "a.b.pipedrive.com" })).toThrow(DatabaseConfigError);
    expect(() => readPipedriveToken("")).toThrow(DatabaseConfigError);
    expect(() => readPipedriveToken("short")).toThrow(DatabaseConfigError);
    expect(() => readPipedriveToken("has space!")).toThrow(DatabaseConfigError);
    expect(() => readPipedriveToken("x".repeat(8001))).toThrow(DatabaseConfigError);
  });
});
