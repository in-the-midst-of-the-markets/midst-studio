import { describe, expect, test } from "bun:test";
import { DatabaseConfigError, QueryError } from "@/lib/db/errors";
import { tiktokAdsAdvertiserId, tiktokAdsHost, readTikTokAdsToken } from "@/lib/db/providers/sql/tiktokads/auth";
import { TIKTOKADS_SQL_GRAMMAR } from "@/lib/db/providers/sql/tiktokads/sql-grammar";
import {
  TIKTOK_ADS_ROW_CAP,
  tiktokAdsRows,
  translateTikTokAdsSql,
  type TikTokAdsSelect,
} from "@/lib/db/providers/sql/tiktokads/translate";
import type { DatabaseConnection } from "@/lib/types";

const base = {
  id: "tt",
  name: "tt",
  type: "tiktokads",
  host: "",
  user: "",
  database: "7123456789",
  password: "access-token-value",
  createdAt: new Date(0),
} as DatabaseConnection;

function select(sql: string): TikTokAdsSelect {
  return translateTikTokAdsSql(sql);
}

describe("TikTok Ads SQL", () => {
  test("reads one resource, then filters and pages the answer", () => {
    const campaign = select(
      "SELECT campaign.name, campaign.budget FROM campaign WHERE campaign.operation_status = 'ENABLE' AND campaign.name LIKE '%a.c%' AND campaign.budget > 10 ORDER BY campaign.budget DESC LIMIT 100",
    );
    expect(campaign.resource.path).toBe("/open_api/v1.3/campaign/get/");
    expect(campaign.columns).toEqual(["campaign.name", "campaign.budget"]);
    const rows = tiktokAdsRows(
      campaign,
      [
        { campaign_id: "1", campaign_name: "a.c", operation_status: "ENABLE", budget: 12 },
        { campaign_id: "2", campaign_name: "axc", operation_status: "ENABLE", budget: 20 },
        { campaign_id: "3", campaign_name: "a.c", operation_status: "DISABLE", budget: 30 },
        { campaign_id: "4", campaign_name: "a.c", operation_status: "ENABLE", budget: "nope" },
      ],
      campaign.resource.path,
    );
    expect(rows.map((row) => row["campaign.name"])).toEqual(["a.c"]);

    const star = select("SELECT * FROM campaign");
    expect(star.columns).toBeNull();
    expect(
      tiktokAdsRows(star, [{ campaign_id: "9", campaign_name: "Brand", budget: 12.5, extra: { a: 1 } }], "sql")[0],
    ).toMatchObject({
      "campaign.id": "9",
      "campaign.name": "Brand",
      "campaign.budget": 12.5,
    });

    expect(select("SELECT ad_group.name FROM ad_group").resource.path).toBe("/open_api/v1.3/adgroup/get/");
    expect(select("SELECT ad.name FROM ad WHERE ad.operation_status = 'ENABLE'").resource.path).toBe(
      "/open_api/v1.3/ad/get/",
    );
    const ads = tiktokAdsRows(
      select("SELECT ad.name FROM ad WHERE ad.operation_status = 'ENABLE' AND ad.modify_time IS NOT NULL"),
      [
        { ad_id: "1", ad_name: "Clip", operation_status: "ENABLE", modify_time: "2026-01-01" },
        { ad_id: "2", ad_name: "Later", operation_status: "DISABLE" },
      ],
      "sql",
    );
    expect(ads).toHaveLength(1);

    const decimal = select("SELECT campaign.id FROM campaign WHERE campaign.budget = 1.5 AND campaign.budget = -1");
    expect(tiktokAdsRows(decimal, [{ campaign_id: "1", budget: 1.5 }], "sql")).toEqual([]);
    const objectName = select("SELECT campaign.id FROM campaign WHERE campaign.name = 'x'");
    expect(
      tiktokAdsRows(
        objectName,
        [
          { campaign_id: "1", campaign_name: null },
          { campaign_id: "2", campaign_name: { a: 1 } },
        ],
        "sql",
      ),
    ).toEqual([]);

    const bounds = select(
      "SELECT campaign.name FROM campaign WHERE campaign.name != 'A' AND campaign.name <> 'B' AND campaign.name > 'C' AND campaign.name >= 'M' AND campaign.name <= 'Z' ORDER BY campaign.name ASC",
    );
    expect(
      tiktokAdsRows(
        bounds,
        [
          { campaign_id: "1", campaign_name: "C" },
          { campaign_id: "2", campaign_name: "M" },
          { campaign_id: "3", campaign_name: "Z" },
        ],
        "sql",
      ).map((row) => row["campaign.name"]),
    ).toEqual(["M", "Z"]);

    const numbers = select(
      "SELECT campaign.id FROM campaign WHERE campaign.budget < 5 AND campaign.budget <= 4 AND campaign.budget >= 1 AND campaign.budget != 9",
    );
    expect(
      tiktokAdsRows(
        numbers,
        [
          { campaign_id: "2", budget: 4 },
          { campaign_id: "9", budget: 9 },
        ],
        "sql",
      ),
    ).toHaveLength(1);

    const quoted = select(
      "SELECT \"campaign.name\" FROM campaign WHERE campaign.name = 'O''Brien' -- note\n /* block */ ;",
    );
    expect(tiktokAdsRows(quoted, [{ campaign_id: "1", campaign_name: "O'Brien" }], "sql")).toHaveLength(1);

    const unknownFilter = {
      ...select("SELECT campaign.id FROM campaign"),
      filters: [{ field: "campaign.nope", operator: "=" as const, value: "1" }],
    };
    expect(tiktokAdsRows(unknownFilter, [{ campaign_id: "1" }], "sql")).toEqual([]);
    const unknownOrder = {
      ...select("SELECT campaign.id FROM campaign"),
      orderBy: { column: "campaign.nope", desc: false },
    };
    expect(
      tiktokAdsRows(unknownOrder, [{ campaign_id: "2" }, { campaign_id: "1" }], "sql").map((row) => row["campaign.id"]),
    ).toEqual(["2", "1"]);

    const mixed = select("SELECT campaign.id FROM campaign ORDER BY campaign.budget ASC");
    const mixedRows = tiktokAdsRows(mixed, [{ budget: { a: 1 } }, { budget: 2 }, { budget: null }], "sql");
    expect(mixedRows[2]?.["campaign.budget"]).toBeNull();

    const capped = select("SELECT campaign.id FROM campaign LIMIT 5000 OFFSET 20");
    expect(capped.limit).toBe(TIKTOK_ADS_ROW_CAP);
    expect(capped.capped).toBe(true);

    const format = TIKTOKADS_SQL_GRAMMAR.completion.formatSegment;
    const read = TIKTOKADS_SQL_GRAMMAR.completion.readQuotedQualifier;
    expect(format?.('a"b')).toBe('"a""b"');
    expect(read?.('"de""al".')).toBe('de"al');
    expect(TIKTOKADS_SQL_GRAMMAR.grammar.completionWords?.lists).toBe("only");
    expect(TIKTOKADS_SQL_GRAMMAR.completion.nameIsDottedWord).toBe(true);
    expect(TIKTOKADS_SQL_GRAMMAR.readsSqlText).toBe(true);
  });

  test("refuses a statement the API cannot run", () => {
    const refused = [
      "",
      "DELETE FROM campaign",
      "SELECT DISTINCT campaign.id FROM campaign",
      "SELECT COUNT(*) FROM campaign",
      "SELECT campaign.missing FROM campaign",
      "SELECT campaign.id FROM missing",
      "SELECT campaign.id FROM campaign WHERE campaign.operation_status = 'ENABLE' OR campaign.operation_status = 'DISABLE'",
      "SELECT campaign.id FROM campaign WHERE campaign.budget LIKE '%1%'",
      "SELECT campaign.id FROM campaign WHERE campaign.operation_status = ENABLE",
      "SELECT campaign.id FROM campaign WHERE campaign.name IS NOT",
      "SELECT campaign.id FROM campaign WHERE campaign.name IS GONE",
      "SELECT campaign.id FROM campaign ORDER campaign.name",
      "SELECT campaign.id FROM campaign ORDER BY campaign.name, campaign.budget",
      "SELECT campaign.id FROM campaign LIMIT 0",
      "SELECT campaign.id FROM campaign LIMIT -1",
      "SELECT campaign.id FROM campaign OFFSET -1",
      "SELECT campaign.id FROM campaign LIMIT 9999999999999999999",
      "SELECT campaign.id FROM campaign; SELECT campaign.id FROM campaign",
      "SELECT campaign.id FROM campaign /*",
      "SELECT campaign.id FROM campaign WHERE campaign.name = 'open",
      'SELECT campaign.id FROM campaign WHERE campaign.name = "open',
      "SELECT campaign.id FROM campaign WHERE campaign.name = !",
      "SELECT campaign.id FROM campaign WHERE campaign.operation_status IN ('ENABLE')",
      "SELECT 1 FROM campaign",
      "SELECT campaign.id FROM campaign WHERE campaign.name = @",
      'SELECT "ca""mpaign.name" FROM campaign',
      "SELECT campaign.id FROM",
    ];
    for (const sql of refused) {
      expect(() => translateTikTokAdsSql(sql)).toThrow(QueryError);
    }
    expect(() => tiktokAdsRows(select("SELECT campaign.id FROM campaign"), ["nope"], "sql")).toThrow(QueryError);
  });

  test("accepts the API host, a pasted token and an advertiser id, and refuses the rest", () => {
    expect(tiktokAdsHost({ ...base, host: "" })).toBe("business-api.tiktok.com");
    expect(tiktokAdsHost({ ...base, host: " https://Business-API.tiktok.com. " })).toBe("business-api.tiktok.com");
    expect(tiktokAdsHost({ ...base, host: "business-api.tiktok.com/open_api" })).toBe("business-api.tiktok.com");
    expect(readTikTokAdsToken("  Bearer access-token-value  ")).toBe("access-token-value");
    expect(tiktokAdsAdvertiserId(base)).toBe("7123456789");
    const evil = "https://evil.example/token";
    expect(() => tiktokAdsHost({ ...base, host: evil })).toThrow(DatabaseConfigError);
    try {
      tiktokAdsHost({ ...base, host: evil });
    } catch (error) {
      expect((error as Error).message).not.toContain("evil.example");
      expect((error as Error).message).not.toContain("access-token-value");
    }
    expect(() => tiktokAdsHost({ ...base, host: "ads.tiktok.com" })).toThrow(DatabaseConfigError);
    expect(() => readTikTokAdsToken("")).toThrow(DatabaseConfigError);
    expect(() => readTikTokAdsToken("short")).toThrow(DatabaseConfigError);
    expect(() => readTikTokAdsToken("has space!")).toThrow(DatabaseConfigError);
    expect(() => readTikTokAdsToken("x".repeat(8001))).toThrow(DatabaseConfigError);
    expect(() => tiktokAdsAdvertiserId({ ...base, database: "" })).toThrow(DatabaseConfigError);
    expect(() => tiktokAdsAdvertiserId({ ...base, database: "0" })).toThrow(DatabaseConfigError);
    expect(() => tiktokAdsAdvertiserId({ ...base, database: "abc" })).toThrow(DatabaseConfigError);
    expect(() => tiktokAdsAdvertiserId({ ...base, database: "1".repeat(21) })).toThrow(DatabaseConfigError);
  });
});
