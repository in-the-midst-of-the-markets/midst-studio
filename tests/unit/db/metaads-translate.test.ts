import { describe, expect, test } from "bun:test";
import { DatabaseConfigError, QueryError } from "@/lib/db/errors";
import { metaAdsAccountId, metaAdsHost, readMetaAdsToken } from "@/lib/db/providers/sql/metaads/auth";
import { METAADS_SQL_GRAMMAR } from "@/lib/db/providers/sql/metaads/sql-grammar";
import {
  META_ADS_ROW_CAP,
  metaAdsRows,
  translateMetaAdsSql,
  type MetaAdsSelect,
} from "@/lib/db/providers/sql/metaads/translate";
import type { DatabaseConnection } from "@/lib/types";

const base = {
  id: "meta",
  name: "meta",
  type: "metaads",
  host: "",
  user: "",
  database: "100539998049706",
  password: "access-token-value",
  createdAt: new Date(0),
} as DatabaseConnection;

function select(sql: string): MetaAdsSelect {
  return translateMetaAdsSql(sql);
}

describe("Meta Ads SQL", () => {
  test("reads one resource, then filters and pages the answer", () => {
    const campaign = select(
      "SELECT campaign.name, campaign.daily_budget FROM campaign WHERE campaign.status = 'ACTIVE' AND campaign.name LIKE '%a.c%' AND campaign.daily_budget > 10 ORDER BY campaign.daily_budget DESC LIMIT 100",
    );
    expect(campaign.resource.path).toBe("/campaigns");
    expect(campaign.columns).toEqual(["campaign.name", "campaign.daily_budget"]);
    const rows = metaAdsRows(
      campaign,
      [
        { id: "1", name: "a.c", status: "ACTIVE", daily_budget: "12" },
        { id: "2", name: "axc", status: "ACTIVE", daily_budget: "20" },
        { id: "3", name: "a.c", status: "PAUSED", daily_budget: null, lifetime_budget: 9 },
        { id: "5", name: "other", status: "ACTIVE", daily_budget: "nope" },
      ],
      "sql",
    );
    expect(rows.map((row) => row["campaign.name"])).toEqual(["a.c"]);
    expect(rows[0]?.["campaign.daily_budget"]).toBe(12);

    const star = select("SELECT * FROM ad_set");
    expect(star.resource.path).toBe("/adsets");
    expect(star.columns).toBeNull();
    expect(metaAdsRows(star, [{ id: "9", name: "Prospects", campaign_id: "4" }], "sql")[0]).toMatchObject({
      "ad_set.id": "9",
      "ad_set.name": "Prospects",
      "campaign.id": "4",
    });
    const ad = select("SELECT ad.name FROM ad WHERE ad.status = 'ACTIVE'");
    expect(ad.resource.path).toBe("/ads");
    expect(metaAdsRows(ad, [{ id: "7", name: "Creative", status: "ACTIVE" }], "sql")[0]).toMatchObject({
      "ad.name": "Creative",
    });

    const capped = select("SELECT campaign.id FROM campaign LIMIT 5000 OFFSET 20");
    expect(capped.limit).toBe(META_ADS_ROW_CAP);
    expect(capped.capped).toBe(true);

    const format = METAADS_SQL_GRAMMAR.completion.formatSegment;
    const read = METAADS_SQL_GRAMMAR.completion.readQuotedQualifier;
    expect(format?.('a"b')).toBe('"a""b"');
    expect(read?.('"de""al".')).toBe('de"al');
    expect(read?.("campaign.")).toBeUndefined();
    expect(METAADS_SQL_GRAMMAR.grammar.completionWords?.lists).toBe("only");
    expect(METAADS_SQL_GRAMMAR.completion.nameIsDottedWord).toBe(true);
    expect(METAADS_SQL_GRAMMAR.readsSqlText).toBe(true);
  });

  test("refuses a statement the API cannot run", () => {
    expect(() => translateMetaAdsSql("DELETE FROM campaign")).toThrow(QueryError);
    expect(() => translateMetaAdsSql("SELECT campaign.id")).toThrow(QueryError);
    expect(() => metaAdsRows(select("SELECT campaign.id FROM campaign"), ["nope"], "sql")).toThrow(QueryError);
    expect(() => metaAdsRows(select("SELECT campaign.id FROM campaign"), [null], "sql")).toThrow(QueryError);
    expect(() => metaAdsRows(select("SELECT campaign.id FROM campaign"), [[]], "sql")).toThrow(QueryError);
  });

  test("accepts the API host, a pasted token and an ad account id, and refuses the rest", () => {
    expect(metaAdsHost({ ...base, host: "" })).toBe("graph.facebook.com");
    expect(metaAdsHost({ ...base, host: " https://Graph.facebook.com/v27.0 " })).toBe("graph.facebook.com");
    expect(readMetaAdsToken("  Bearer access-token-value  ")).toBe("access-token-value");
    expect(metaAdsAccountId(base)).toBe("100539998049706");
    expect(metaAdsAccountId({ ...base, database: "act_100539998049706" })).toBe("100539998049706");
    expect(metaAdsAccountId({ ...base, database: "ACT_12" })).toBe("12");
    const evil = "https://evil.example/token";
    expect(() => metaAdsHost({ ...base, host: evil })).toThrow(DatabaseConfigError);
    try {
      metaAdsHost({ ...base, host: evil });
    } catch (error) {
      expect((error as Error).message).not.toContain("evil.example");
      expect((error as Error).message).not.toContain("access-token-value");
    }
    expect(() => metaAdsHost({ ...base, host: "ads.facebook.com" })).toThrow(DatabaseConfigError);
    try {
      metaAdsHost({ ...base, host: "ads.facebook.com" });
    } catch (error) {
      expect((error as Error).message).not.toContain("ads.facebook.com");
    }
    expect(() => readMetaAdsToken("")).toThrow(DatabaseConfigError);
    expect(() => readMetaAdsToken(undefined)).toThrow(DatabaseConfigError);
    expect(() => readMetaAdsToken("short")).toThrow(DatabaseConfigError);
    expect(() => readMetaAdsToken("has space!")).toThrow(DatabaseConfigError);
    expect(() => readMetaAdsToken("x".repeat(8001))).toThrow(DatabaseConfigError);
    expect(() => metaAdsAccountId({ ...base, database: "" })).toThrow(DatabaseConfigError);
    expect(() => metaAdsAccountId({ ...base, database: undefined })).toThrow(DatabaseConfigError);
    expect(() => metaAdsAccountId({ ...base, database: "0" })).toThrow(DatabaseConfigError);
    expect(() => metaAdsAccountId({ ...base, database: "act_" })).toThrow(DatabaseConfigError);
    expect(() => metaAdsAccountId({ ...base, database: "1".repeat(21) })).toThrow(DatabaseConfigError);
  });
});
