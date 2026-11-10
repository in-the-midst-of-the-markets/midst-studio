import { describe, expect, test } from "bun:test";
import { AuthenticationError, DatabaseConfigError, QueryError } from "@/lib/db/errors";
import { dynamicsCredential, dynamicsOrgHost, readDynamicsTokenGrant } from "@/lib/db/providers/sql/dynamics/auth";
import { DYNAMICS_SQL_GRAMMAR } from "@/lib/db/providers/sql/dynamics/sql-grammar";
import {
  DYNAMICS_ENTITIES,
  dynamicsOData,
  translateDynamicsSql,
  type DynamicsStatement,
} from "@/lib/db/providers/sql/dynamics/translate";
import type { DatabaseConnection } from "@/lib/types";

const base = {
  id: "dy",
  name: "dy",
  type: "dynamics",
  password: "access-token-value",
  createdAt: new Date(0),
} as DatabaseConnection;

const client = {
  ...base,
  user: "11111111-1111-1111-1111-111111111111",
  database: "22222222-2222-2222-2222-222222222222",
  password: "client-secret-value",
} as DatabaseConnection;

function refused(sql: string): string {
  try {
    dynamicsOData(translateDynamicsSql(sql), sql);
  } catch (error) {
    expect(error).toBeInstanceOf(QueryError);
    return error instanceof Error ? error.message : "";
  }
  throw new Error(`accepted ${sql}`);
}

function accepted(sql: string): DynamicsStatement {
  return translateDynamicsSql(sql);
}

describe("Dynamics SQL", () => {
  test("reads one filtered page and one count", () => {
    const page = accepted(
      "SELECT name, emailaddress1 FROM Accounts WHERE name = 'O''Brien' AND revenue >= 10 ORDER BY name DESC LIMIT 5 OFFSET 2",
    );
    expect(page).toMatchObject({
      kind: "select",
      columns: ["name", "emailaddress1"],
      limit: 5,
      offset: 2,
      capped: false,
      orderBy: { column: "name", desc: true },
    });
    const query = dynamicsOData(page, "select");
    expect(query.path).toBe("/api/data/v9.2/accounts");
    expect(query.params.get("$select")).toBe("name,emailaddress1");
    expect(query.params.get("$filter")).toBe("name eq 'O''Brien' and revenue ge 10");
    expect(query.params.get("$orderby")).toBe("name desc");
    expect(query.params.get("$top")).toBe("5");
    expect(query.params.get("$skip")).toBe("2");

    const counted = accepted("SELECT COUNT(*) AS row_count FROM accounts WHERE name IS NOT NULL");
    expect(counted).toMatchObject({ kind: "count", alias: "row_count" });
    const count = dynamicsOData(counted, "count");
    expect(count.path).toBe("/api/data/v9.2/accounts/$count");
    expect(count.params.get("$filter")).toBe("name ne null");
  });

  test("translates the comparisons Dataverse can filter", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["SELECT name FROM accounts WHERE name != 'A'", "name ne 'A'"],
      ["SELECT name FROM accounts WHERE name <> 'A'", "name ne 'A'"],
      ["SELECT revenue FROM accounts WHERE revenue < 1", "revenue lt 1"],
      ["SELECT revenue FROM accounts WHERE revenue > -1.5", "revenue gt -1.5"],
      ["SELECT revenue FROM accounts WHERE revenue <= 2", "revenue le 2"],
      ["SELECT name FROM accounts WHERE name LIKE 'Con%'", "startswith(name,'Con')"],
      ["SELECT name FROM accounts WHERE name LIKE '%oso'", "endswith(name,'oso')"],
      ["SELECT name FROM accounts WHERE name LIKE '%Contoso%'", "contains(name,'Contoso')"],
      ["SELECT name FROM accounts WHERE name LIKE 'Contoso'", "name eq 'Contoso'"],
      ["SELECT name FROM accounts WHERE name IS NULL", "name eq null"],
      ["SELECT createdon FROM accounts WHERE createdon >= '2026-01-31'", "createdon ge 2026-01-31T00:00:00Z"],
      [
        "SELECT createdon FROM accounts WHERE createdon < '2026-01-31T13:05:09.1234567Z'",
        "createdon lt 2026-01-31T13:05:09.1234567Z",
      ],
      [
        "SELECT parentcustomerid FROM contacts WHERE parentcustomerid = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE'",
        "_parentcustomerid_value eq aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      ],
      ["SELECT isdisabled FROM systemusers WHERE isdisabled = FALSE", "isdisabled eq false"],
    ];
    for (const [sql, filter] of cases) {
      expect(dynamicsOData(accepted(sql), sql).params.get("$filter")).toBe(filter);
    }
    const star = accepted("-- note\nSELECT * FROM accounts /* kept */ WHERE name = 'A';");
    expect(star).toMatchObject({ kind: "select", columns: null, limit: 100, offset: 0 });
    expect(dynamicsOData(star, "star").params.get("$select")).toBe(
      DYNAMICS_ENTITIES[0]?.columns.map((column) => column.select).join(","),
    );
    expect(dynamicsOData(star, "star").params.get("$orderby")).toBeNull();
    expect(accepted('SELECT "name" FROM accounts ORDER BY name ASC').kind).toBe("select");
    expect(accepted("SELECT name FROM accounts LIMIT 5000 OFFSET 0")).toMatchObject({ limit: 1000, capped: true });
    expect(accepted("SELECT name FROM accounts LIMIT 200 OFFSET 900")).toMatchObject({
      limit: 200,
      offset: 900,
      capped: true,
    });
  });

  test("refuses SQL the Web API read does not run", () => {
    const cases: ReadonlyArray<readonly [string, RegExp]> = [
      ["", /Write a SELECT/],
      ["INSERT INTO accounts (name) VALUES ('A')", /read-only/],
      ["SELECT DISTINCT name FROM accounts", /DISTINCT/],
      ["SELECT COUNT(name) FROM accounts", /COUNT\(\*\)/],
      ["SELECT COUNT(*) AS row_count FROM accounts ORDER BY name", /no page/],
      ["SELECT COUNT(*) FROM missing", /no table/],
      ["SELECT missing FROM accounts", /no field/],
      ["SELECT * FROM accounts WHERE missing = 'A'", /no field/],
      ["SELECT * FROM accounts WHERE name = 'A' OR name = 'B'", /AND/],
      ["SELECT * FROM accounts WHERE name IS EMPTY", /IS NULL/],
      ["SELECT * FROM accounts WHERE name IN ('A')", /Compare/],
      ["SELECT * FROM accounts WHERE revenue = '1'", /number/],
      ["SELECT * FROM accounts WHERE name = 1", /quotes/],
      ["SELECT * FROM systemusers WHERE isdisabled = 'true'", /true or false/],
      ["SELECT * FROM accounts WHERE revenue LIKE '1%'", /text field/],
      ["SELECT * FROM accounts WHERE name LIKE 1", /LIKE pattern/],
      ["SELECT * FROM accounts ORDER name", /ORDER BY/],
      ["SELECT * FROM accounts ORDER BY name, revenue", /one field/],
      ["SELECT * FROM accounts LIMIT 0", /positive whole number/],
      ["SELECT * FROM accounts LIMIT 1.5", /positive whole number/],
      ["SELECT * FROM accounts OFFSET no", /whole number/],
      [`SELECT * FROM accounts LIMIT ${"9".repeat(20)}`, /positive whole number/],
      ["SELECT * FROM accounts; SELECT * FROM contacts", /one statement/],
      ["SELECT * FROM accounts WHERE name = 'A", /quoted text/],
      ['SELECT * FROM "accounts', /quoted name/],
      ["SELECT * FROM accounts /*", /block comment/],
      ["SELECT - FROM accounts", /read-only/],
      ["SELECT * FROM accounts WHERE name ! 'A'", /read-only/],
      [`SELECT ${"n".repeat(81)} FROM accounts`, /field name/],
      ['SELECT "a b" FROM accounts', /field name/],
      ["SELECT * FROM accounts JOIN contacts", /read-only/],
      ['SELECT "na""me" FROM accounts', /field name/],
      ["SELECT customer.name FROM accounts", /no field/],
      ["SELECT @ FROM accounts", /read-only/],
      ["SELECT 1 FROM accounts", /field name/],
    ];
    for (const [sql, pattern] of cases) expect(refused(sql)).toMatch(pattern);
    expect(refused("SELECT name FROM accounts WHERE name LIKE '%a%b%'")).toMatch(/% only/);
    expect(refused("SELECT name FROM accounts WHERE name LIKE '%a_b%'")).toMatch(/% only/);
    expect(refused("SELECT createdon FROM accounts WHERE createdon = '2026-02-31'")).toMatch(/real date/);
    expect(refused("SELECT createdon FROM accounts WHERE createdon = 'yesterday'")).toMatch(/real date/);
    expect(refused("SELECT createdon FROM accounts WHERE createdon = '2026-01-31T25:00:00Z'")).toMatch(/real date/);
    expect(refused("SELECT createdon FROM accounts WHERE createdon = '2026-13-01T00:00:00Z'")).toMatch(/real date/);
    expect(refused("SELECT parentcustomerid FROM contacts WHERE parentcustomerid = 'not-a-guid'")).toMatch(/GUID/);
    const accounts = DYNAMICS_ENTITIES[0];
    expect(accounts).toBeDefined();
    expect(() =>
      dynamicsOData(
        {
          kind: "count",
          entity: accounts as (typeof DYNAMICS_ENTITIES)[number],
          alias: "totalCount",
          filters: [{ field: "missing", operator: "=", value: "A" }],
        },
        "built",
      ),
    ).toThrow(/no field/);
  });
});

describe("Dynamics completion", () => {
  test("quotes a name that contains a quote and reads one back", () => {
    const completion = DYNAMICS_SQL_GRAMMAR.completion;
    const format = completion.formatSegment;
    const read = completion.readQuotedQualifier;
    if (format === null || read === null) throw new Error("Dynamics completion quotes names.");
    expect(format('a"b')).toBe('"a""b"');
    expect(read('SELECT "na""me".')).toBe('na"me');
    expect(read("SELECT name.")).toBeUndefined();
  });
});

describe("Dynamics credentials", () => {
  test("accepts an organization host and either credential", () => {
    expect(dynamicsOrgHost({ ...base, host: " https://CONTOSO.CRM.DYNAMICS.COM/ " })).toBe("contoso.crm.dynamics.com");
    expect(dynamicsOrgHost({ ...base, host: "org-name.crm21.dynamics.com." })).toBe("org-name.crm21.dynamics.com");
    expect(dynamicsOrgHost({ ...base, host: "contoso.crm4.dynamics.com" })).toBe("contoso.crm4.dynamics.com");
    expect(dynamicsCredential(base)).toEqual({ kind: "token", token: "access-token-value" });
    expect(dynamicsCredential({ ...base, password: "Bearer access-token-value" })).toEqual({
      kind: "token",
      token: "access-token-value",
    });
    expect(dynamicsCredential({ ...client, user: "11111111-1111-1111-1111-111111111111".toUpperCase() })).toMatchObject(
      {
        kind: "client",
        clientId: "11111111-1111-1111-1111-111111111111",
        tenantId: "22222222-2222-2222-2222-222222222222",
      },
    );
  });

  test("refuses a host or a secret it would have to send somewhere else", () => {
    expect(() => dynamicsOrgHost(base)).toThrow(DatabaseConfigError);
    expect(() => dynamicsOrgHost({ ...base, host: "   " })).toThrow(/organization host is required/);
    expect(() => dynamicsOrgHost({ ...base, host: "https://[" })).toThrow(DatabaseConfigError);
    for (const host of [
      "http://contoso.crm.dynamics.com",
      "https://contoso.crm.dynamics.com/api",
      "https://user:access-token-value@contoso.crm.dynamics.com",
      "contoso.crm.dynamics.com:443",
      "contoso.crm0.dynamics.com",
      "crm.dynamics.com",
      "contoso.crm.dynamics.com.evil.example",
      "evil.example",
    ]) {
      try {
        dynamicsOrgHost({ ...base, host });
        throw new Error(`accepted ${host}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        expect(message).toContain("contoso.crm.dynamics.com");
        expect(message).not.toContain("evil");
        expect(message).not.toContain("access-token-value");
        expect(message).not.toContain("user:access");
      }
    }
    expect(() => dynamicsCredential({ ...base, password: "  " })).toThrow(/required/);
    expect(() => dynamicsCredential({ ...base, user: "11111111-1111-1111-1111-111111111111" })).toThrow(
      /both required/,
    );
    try {
      dynamicsCredential({ ...client, password: "client-secret-value\r\nX-Injected: 1" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      expect(message).toMatch(/single line/);
      expect(message).not.toContain("Injected");
      expect(message).not.toContain("client-secret");
    }
    expect(() => dynamicsCredential({ ...client, user: "not-a-guid" })).toThrow(/GUID/);
    expect(() => dynamicsCredential({ ...client, password: "x".repeat(1025) })).toThrow(/larger than Studio/);
    expect(() => dynamicsCredential({ ...base, password: "y".repeat(8001) })).toThrow(/larger than Studio/);
  });

  test("reads a token response without repeating the secret", () => {
    expect(
      readDynamicsTokenGrant(200, JSON.stringify({ access_token: "issued-token", expires_in: 120 }), 5_000, []),
    ).toEqual({
      token: "issued-token",
      expiresAt: 65_000,
    });
    expect(
      readDynamicsTokenGrant(200, JSON.stringify({ access_token: "issued-token", expires_in: 30 }), 5_000, []),
    ).toEqual({
      token: "issued-token",
      expiresAt: 5_000,
    });
    expect(() => readDynamicsTokenGrant(400, "not-json", 0, [])).toThrow(AuthenticationError);
    expect(() => readDynamicsTokenGrant(200, JSON.stringify({ error: 12 }), 0, [])).toThrow(/HTTP 200/);
    expect(() => readDynamicsTokenGrant(200, JSON.stringify({ access_token: "has space" }), 0, [])).toThrow(
      AuthenticationError,
    );
    try {
      readDynamicsTokenGrant(400, JSON.stringify({ error_description: "rejected client-secret-value" }), 0, [
        "client-secret-value",
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      expect(message).toContain("••••");
      expect(message).not.toContain("client-secret-value");
    }
  });
});
