import { describe, expect, test } from "bun:test";
import { DatabaseConfigError, QueryError } from "@/lib/db/errors";
import {
  microsoftAdsAccountId,
  microsoftAdsCustomerId,
  microsoftAdsHost,
  readMicrosoftAdsCredential,
} from "@/lib/db/providers/sql/microsoftads/auth";
import { MICROSOFTADS_SQL_GRAMMAR } from "@/lib/db/providers/sql/microsoftads/sql-grammar";
import {
  MICROSOFT_ADS_CAMPAIGN_TYPES,
  microsoftAdsCall,
  microsoftAdsRows,
  translateMicrosoftAdsSql,
  type MicrosoftAdsSelect,
} from "@/lib/db/providers/sql/microsoftads/translate";
import type { DatabaseConnection } from "@/lib/types";

const secret = JSON.stringify({
  accessToken: "Bearer access-token-value",
  developerToken: "BBD37VB98",
});

function connection(overrides: Partial<DatabaseConnection> = {}): DatabaseConnection {
  return {
    id: "ads",
    name: "ads",
    type: "microsoftads",
    host: "campaign.api.bingads.microsoft.com",
    user: "123456",
    database: "7654321",
    password: secret,
    createdAt: new Date(0),
    ...overrides,
  };
}

function sql(text: string): MicrosoftAdsSelect {
  return translateMicrosoftAdsSql(text);
}

describe("Microsoft Ads SQL", () => {
  test("reads one resource and applies the filter locally", () => {
    const statement = sql(
      "SELECT campaign.name, campaign.status FROM campaign WHERE campaign.status = 'Active' AND campaign.name LIKE 'Brand%' ORDER BY campaign.name DESC LIMIT 10",
    );
    const call = microsoftAdsCall(statement, 7654321, "campaign");
    expect(call.path).toBe("/CampaignManagement/v13/Campaigns/QueryByAccountId");
    expect(call.body).toEqual({ AccountId: 7654321, CampaignType: MICROSOFT_ADS_CAMPAIGN_TYPES });
    expect(call.parentId).toBeNull();
    const rows = microsoftAdsRows(
      statement,
      [
        { Id: 2, Name: "Brand shoes", Status: "Active", DailyBudget: "12.5" },
        { Id: "1", Name: "Other", Status: "Paused", DailyBudget: { nested: true } },
        { Id: 3, Name: "Brand hats", Status: true, DailyBudget: null },
      ],
      null,
      "campaign",
    );
    expect(rows.map((row) => row["campaign.name"])).toEqual(["Brand shoes"]);
    const star = sql("SELECT * FROM campaign WHERE campaign.daily_budget >= 10 AND campaign.daily_budget <> 99");
    const starred = microsoftAdsRows(
      star,
      [
        {
          Id: 4,
          Name: "C",
          Status: "Active",
          DailyBudget: 12.5,
          CampaignType: "Search",
          BudgetType: "DailyBudgetStandard",
        },
      ],
      null,
      "star",
    );
    expect(starred[0]?.["campaign.daily_budget"]).toBe(12.5);
    const adGroup = sql(
      "SELECT ad_group.name, campaign.id FROM ad_group WHERE campaign.id = 00015 AND ad_group.name < 'M'",
    );
    const grouped = microsoftAdsCall(adGroup, 7654321, "group");
    expect(grouped).toEqual({
      path: "/CampaignManagement/v13/AdGroups/QueryByCampaignId",
      body: { CampaignId: 15 },
      parentId: "15",
    });
    expect(
      microsoftAdsRows(
        adGroup,
        [
          { Id: 8, Name: "Alpha", Status: "Active" },
          { Id: 9, Name: null },
        ],
        "15",
        "group",
      ).map((row) => row["ad_group.name"]),
    ).toEqual(["Alpha"]);
    const same = sql("SELECT ad_group.id FROM ad_group WHERE campaign.id = 15 AND campaign.id = 15");
    expect(microsoftAdsCall(same, 1, "same").parentId).toBe("15");
    const ad = sql(
      "SELECT ad.type FROM ad WHERE ad_group.id = 4 AND ad.status != 'Paused' AND ad.editorial_status <= 'Z'",
    );
    expect(microsoftAdsCall(ad, 1, "ad").body).toEqual({ AdGroupId: 4 });
    const keyword = sql(
      "SELECT keyword.text FROM keyword WHERE ad_group.id = 4 AND keyword.match_type > 'A' AND keyword.status >= 'A' AND keyword.text IS NOT NULL",
    );
    expect(microsoftAdsCall(keyword, 1, "keyword").path).toContain("Keywords/QueryByAdGroupId");
    const missed = sql("SELECT keyword.text FROM keyword WHERE ad_group.id = 4 AND keyword.text IS NULL");
    expect(
      microsoftAdsRows(missed, [{ Id: 1, Text: null, MatchType: "Exact", Status: "Active" }], "4", "miss").length,
    ).toBe(1);
    const unlike = sql("SELECT campaign.name FROM campaign WHERE campaign.name != 'A' AND campaign.status <> 'Paused'");
    expect(microsoftAdsRows(unlike, [{ Id: 1, Name: "B", Status: "Active" }], null, "unlike")).toHaveLength(1);
    const low = sql(
      "SELECT campaign.daily_budget FROM campaign WHERE campaign.daily_budget < 5 AND campaign.daily_budget <= 5 AND campaign.daily_budget > 1",
    );
    expect(microsoftAdsRows(low, [{ Id: 1, DailyBudget: 3 }], null, "low")).toHaveLength(1);
    const bounds = sql(
      "SELECT campaign.name FROM campaign WHERE campaign.name > 'A' AND campaign.name >= 'B' AND campaign.name <= 'Z' ORDER BY campaign.name ASC",
    );
    expect(
      microsoftAdsRows(
        bounds,
        [
          { Id: "1", Name: "M" },
          { Id: 2, Name: "C" },
        ],
        null,
        "bounds",
      ).map((row) => row["campaign.name"]),
    ).toEqual(["C", "M"]);
    const quoted = sql("SELECT campaign.name FROM campaign WHERE campaign.name = 'O''Brien'");
    expect(microsoftAdsRows(quoted, [{ Id: 1, Name: "O'Brien" }], null, "quote")).toHaveLength(1);
    const pattern = sql("SELECT campaign.name FROM campaign WHERE campaign.name LIKE '%a.c%'");
    expect(
      microsoftAdsRows(
        pattern,
        [
          { Id: 1, Name: "a.c" },
          { Id: 2, Name: "axc" },
        ],
        null,
        "like",
      ),
    ).toHaveLength(1);
    const injected = microsoftAdsRows({ ...adGroup, filters: [] }, [{ Id: 1, Name: "A" }], null, "inject");
    expect(injected[0]?.["campaign.id"]).toBeNull();
    const badEntry = { ...adGroup, filters: [{ field: "missing", operator: "=" as const, value: "1" }] };
    expect(microsoftAdsRows(badEntry, [{ Id: 1, Name: "A" }], "15", "bad")).toEqual([]);
    const unsorted = {
      ...sql("SELECT campaign.name FROM campaign"),
      orderBy: { column: "missing", desc: false },
    };
    expect(
      microsoftAdsRows(
        unsorted,
        [
          { Id: 1, Name: "B" },
          { Id: 2, Name: "A" },
        ],
        null,
        "sort",
      ).map((row) => row["campaign.name"]),
    ).toEqual(["B", "A"]);
    const mixed = sql("SELECT campaign.daily_budget FROM campaign ORDER BY campaign.daily_budget ASC");
    const mixedIds = microsoftAdsRows(
      mixed,
      [
        { Id: 1, DailyBudget: { n: 1 } },
        { Id: 2, DailyBudget: 2 },
        { Id: 3, DailyBudget: null },
      ],
      null,
      "mix",
    ).map((row) => row["campaign.id"]);
    expect(mixedIds[2]).toBe(3);
    expect(mixedIds.slice(0, 2).sort()).toEqual([1, 2]);
    const nope = sql("SELECT campaign.daily_budget FROM campaign WHERE campaign.daily_budget = 1");
    const broken = { ...nope, filters: [{ field: "campaign.daily_budget", operator: "=" as const, value: "nope" }] };
    expect(microsoftAdsRows(broken, [{ Id: 1, DailyBudget: 1 }], null, "nope")).toEqual([]);
    const capped = sql("SELECT campaign.id FROM campaign LIMIT 5000 OFFSET 20");
    expect(capped.limit).toBe(1000);
    expect(capped.capped).toBe(true);
    const comments = sql('SELECT "campaign.name" -- note\nFROM campaign /* keep */ ;');
    expect(comments.columns).toEqual(["campaign.name"]);
    const format = MICROSOFTADS_SQL_GRAMMAR.completion.formatSegment;
    const read = MICROSOFTADS_SQL_GRAMMAR.completion.readQuotedQualifier;
    expect(format?.('a"b')).toBe('"a""b"');
    expect(read?.('"campaign.name".')).toBe("campaign.name");
    expect(MICROSOFTADS_SQL_GRAMMAR.grammar.completionWords?.lists).toBe("only");
    expect(MICROSOFTADS_SQL_GRAMMAR.completion.nameIsDottedWord).toBe(true);
  });

  test("refuses a statement the API cannot run", () => {
    const refused = [
      "",
      "DELETE FROM campaign",
      "SELECT DISTINCT campaign.name FROM campaign",
      "SELECT COUNT(*) FROM campaign",
      "SELECT nope FROM campaign",
      "SELECT campaign.name FROM nope",
      "SELECT campaign.name FROM campaign OR",
      "SELECT campaign.name FROM campaign WHERE campaign.name = 'A' OR campaign.name = 'B'",
      "SELECT campaign.name FROM campaign WHERE campaign.daily_budget LIKE '1'",
      "SELECT campaign.name FROM campaign WHERE campaign.name LIKE 1",
      "SELECT campaign.name FROM campaign WHERE campaign.name = 1",
      "SELECT campaign.name FROM campaign WHERE campaign.name IS NOT",
      "SELECT campaign.name FROM campaign WHERE campaign.name IS GONE",
      "SELECT campaign.name FROM campaign ORDER campaign.name",
      "SELECT campaign.name FROM campaign ORDER BY campaign.name, campaign.id",
      "SELECT campaign.name FROM campaign LIMIT 0",
      "SELECT campaign.name FROM campaign LIMIT -1",
      "SELECT campaign.name FROM campaign OFFSET -1",
      "SELECT campaign.name FROM campaign LIMIT 999999999999999999",
      "SELECT campaign.name FROM campaign; SELECT campaign.id FROM campaign",
      "SELECT campaign.name FROM campaign /*",
      "SELECT 'open FROM campaign",
      'SELECT "open FROM campaign',
      'SELECT "camp""aign.name" FROM campaign',
      "SELECT campaign.name FROM campaign WHERE campaign.name ! 'A'",
      "SELECT campaign.name FROM campaign WHERE campaign.name IN ('A')",
      "SELECT 1 FROM campaign",
      "SELECT campaign.name FROM campaign @",
      "SELECT ad_group.name FROM ad_group",
      "SELECT ad.id FROM ad WHERE ad_group.id != 4",
      "SELECT keyword.id FROM keyword WHERE ad_group.id = 0",
      "SELECT ad_group.id FROM ad_group WHERE campaign.id = 1 AND campaign.id = 2",
      "SELECT ad_group.id FROM ad_group WHERE campaign.id = 1.5",
    ];
    for (const statement of refused) {
      expect(() => {
        const parsed = translateMicrosoftAdsSql(statement);
        microsoftAdsCall(parsed, 1, statement);
      }).toThrow(QueryError);
    }
  });

  test("reads the credential and the two ids", () => {
    expect(microsoftAdsHost(connection({ host: "" }))).toBe("campaign.api.bingads.microsoft.com");
    expect(microsoftAdsHost(connection({ host: "https://Campaign.API.Bingads.Microsoft.com./" }))).toBe(
      "campaign.api.bingads.microsoft.com",
    );
    expect(microsoftAdsHost(connection({ host: "campaign.api.sandbox.bingads.microsoft.com" }))).toBe(
      "campaign.api.sandbox.bingads.microsoft.com",
    );
    expect(microsoftAdsCustomerId(connection({ user: "000123" }))).toBe("123");
    expect(microsoftAdsAccountId(connection({ database: "7654321" }))).toBe("7654321");
    const read = readMicrosoftAdsCredential(secret);
    expect(read.accessToken).toBe("access-token-value");
    expect(read.developerToken).toBe("BBD37VB98");
    expect(
      readMicrosoftAdsCredential(JSON.stringify({ access_token: "token-two", developer_token: "dev-token" }))
        .accessToken,
    ).toBe("token-two");
    const refused = [
      connection({ password: "" }),
      connection({ password: "[]" }),
      connection({ password: "{" }),
      connection({ password: '{"nope":1}' }),
      connection({ password: '{"accessToken":1,"developerToken":"BBD37VB98"}' }),
      connection({ password: '{"accessToken":"short","developerToken":"BBD37VB98"}' }),
      connection({ password: '{"accessToken":"access token","developerToken":"BBD37VB98"}' }),
      connection({ password: `{"accessToken":"${"a".repeat(8001)}","developerToken":"BBD37VB98"}` }),
      connection({ password: `{"accessToken":"access-token-value","developerToken":"${"d".repeat(201)}"}` }),
      connection({ password: "x".repeat(16_001) }),
      connection({ host: "https://evil.example/secret" }),
      connection({ host: "clientcenter.api.bingads.microsoft.com" }),
      connection({ host: "not a host" }),
      connection({ user: "" }),
      connection({ user: "0" }),
      connection({ user: "1234567890123456" }),
      connection({ user: "abc" }),
      connection({ database: "" }),
      connection({ database: "nope" }),
    ];
    for (const item of refused) {
      expect(() => {
        readMicrosoftAdsCredential(item.password);
        microsoftAdsHost(item);
        microsoftAdsCustomerId(item);
        microsoftAdsAccountId(item);
      }).toThrow(DatabaseConfigError);
    }
    expect(() => microsoftAdsHost(connection({ host: "https://evil.example/secret" }))).toThrow(DatabaseConfigError);
    try {
      microsoftAdsHost(connection({ host: "https://evil.example/secret", password: secret }));
    } catch (error) {
      expect(error instanceof DatabaseConfigError ? error.message : "").not.toContain("evil.example");
      expect(error instanceof DatabaseConfigError ? error.message : "").not.toContain("access-token-value");
    }
  });
});
