import { describe, expect, test } from "bun:test";
import { DatabaseConfigError, QueryError } from "@/lib/db/errors";
import {
  amazonAdsClientId,
  amazonAdsClientSecret,
  amazonAdsHost,
  amazonAdsProfileId,
  amazonAdsRefreshToken,
} from "@/lib/db/providers/sql/amazonads/auth";
import { AMAZONADS_SQL_GRAMMAR } from "@/lib/db/providers/sql/amazonads/sql-grammar";
import {
  AMAZON_ADS_ROW_CAP,
  amazonAdsList,
  amazonAdsRows,
  translateAmazonAdsSql,
  type AmazonAdsSelect,
} from "@/lib/db/providers/sql/amazonads/translate";
import type { DatabaseConnection } from "@/lib/types";

const base = {
  id: "ads",
  name: "ads",
  type: "amazonads",
  host: "",
  user: "amzn1.application-oa2-client.example",
  password: "client-secret-value",
  database: "Atzr|refresh-token-value",
  schema: "1234567890",
  createdAt: new Date(0),
} as DatabaseConnection;

function select(sql: string): AmazonAdsSelect {
  return translateAmazonAdsSql(sql);
}

describe("Amazon Ads SQL", () => {
  test("reads one resource, then filters and pages the answer", () => {
    const campaign = select(
      "SELECT campaign.name, campaign.budget FROM campaign WHERE campaign.state = 'ENABLED' AND campaign.name LIKE '%a.c%' AND campaign.budget > 10 ORDER BY campaign.budget DESC LIMIT 50",
    );
    expect(campaign.resource.path).toBe("/sp/campaigns/list");
    expect(campaign.columns).toEqual(["campaign.name", "campaign.budget"]);
    expect(amazonAdsList("campaign")).toEqual({
      media: "application/vnd.spCampaign.v3+json",
      rows: "campaigns",
    });
    const rows = amazonAdsRows(
      campaign,
      [
        { campaignId: 9, name: "a.c", state: "ENABLED", budget: { budget: "12.50", budgetType: "DAILY" } },
        { campaignId: "2", name: "axc", state: "ENABLED", budget: { budget: 20, budgetType: "DAILY" } },
        { campaignId: "3", name: "a.c", state: "PAUSED", budgetAmount: "4" },
        { name: "other", state: "ENABLED", budget: "nope", budgetAmount: "nope" },
        { campaignId: Number.POSITIVE_INFINITY, name: "a.c", state: "ENABLED", budget: { budget: true } },
      ],
      "sql",
    );
    expect(rows.map((row) => row["campaign.name"])).toEqual(["a.c"]);
    expect(rows[0]?.["campaign.budget"]).toBe(12.5);
    expect(rows[0]?.["campaign.campaign_id"]).toBe("9");
    expect(rows[0]?.["campaign.budget_type"]).toBe("DAILY");

    const star = select("SELECT * FROM ad_group");
    expect(star.resource.path).toBe("/sp/adGroups/list");
    expect(star.columns).toBeNull();
    expect(amazonAdsList("ad_group").rows).toBe("adGroups");
    expect(
      amazonAdsRows(star, [{ adGroupId: "9", name: "Prospects", campaignId: "4", defaultBid: "1.25" }], "sql")[0],
    ).toMatchObject({
      "ad_group.ad_group_id": "9",
      "ad_group.name": "Prospects",
      "campaign.campaign_id": "4",
      "ad_group.default_bid": 1.25,
    });
    const ad = select("SELECT product_ad.asin FROM product_ad WHERE product_ad.state = 'ENABLED'");
    expect(ad.resource.path).toBe("/sp/productAds/list");
    expect(amazonAdsList("product_ad").media).toBe("application/vnd.spProductAd.v3+json");
    expect(amazonAdsRows(ad, [{ adId: 7, asin: "B000000000", state: "ENABLED" }], "sql")[0]).toMatchObject({
      "product_ad.ad_id": "7",
      "product_ad.asin": "B000000000",
    });

    const capped = select("SELECT campaign.campaign_id FROM campaign LIMIT 5000 OFFSET 20");
    expect(capped.limit).toBe(AMAZON_ADS_ROW_CAP);
    expect(capped.capped).toBe(true);
    expect(select("SELECT campaign.name FROM campaign").limit).toBe(100);

    const format = AMAZONADS_SQL_GRAMMAR.completion.formatSegment;
    const read = AMAZONADS_SQL_GRAMMAR.completion.readQuotedQualifier;
    expect(format?.('a"b')).toBe('"a""b"');
    expect(read?.('"de""al".')).toBe('de"al');
    expect(read?.("campaign.")).toBeUndefined();
    expect(AMAZONADS_SQL_GRAMMAR.grammar.completionWords?.lists).toBe("only");
    expect(AMAZONADS_SQL_GRAMMAR.completion.nameIsDottedWord).toBe(true);
    expect(AMAZONADS_SQL_GRAMMAR.readsSqlText).toBe(true);
  });

  test("refuses a statement the API cannot run", () => {
    expect(() => translateAmazonAdsSql("DELETE FROM campaign")).toThrow(QueryError);
    expect(() => translateAmazonAdsSql("SELECT campaign.campaign_id")).toThrow(QueryError);
    expect(() => translateAmazonAdsSql("SELECT COUNT(*) FROM campaign")).toThrow(QueryError);
    expect(() => amazonAdsRows(select("SELECT campaign.campaign_id FROM campaign"), ["nope"], "sql")).toThrow(
      QueryError,
    );
    expect(() => amazonAdsRows(select("SELECT campaign.campaign_id FROM campaign"), [null], "sql")).toThrow(QueryError);
    expect(() => amazonAdsList("missing")).toThrow(QueryError);
  });

  test("keeps the secret off a refused host and requires a profile id", () => {
    expect(amazonAdsHost("")).toBe("advertising-api.amazon.com");
    expect(amazonAdsHost("https://advertising-api-eu.amazon.com")).toBe("advertising-api-eu.amazon.com");
    expect(amazonAdsHost("advertising-api-fe.amazon.com")).toBe("advertising-api-fe.amazon.com");
    expect(amazonAdsClientId(base)).toBe("amzn1.application-oa2-client.example");
    expect(amazonAdsClientSecret(base)).toBe("client-secret-value");
    expect(amazonAdsRefreshToken(base)).toBe("Atzr|refresh-token-value");
    expect(amazonAdsProfileId(base)).toBe("1234567890");
    const refused = (host: string): string => {
      try {
        amazonAdsHost(host);
        return "";
      } catch (error) {
        expect(error).toBeInstanceOf(DatabaseConfigError);
        return (error as Error).message;
      }
    };
    expect(refused("https://advertising.amazon.com")).not.toContain("advertising.amazon.com");
    expect(refused("https://api.amazon.com")).not.toContain("api.amazon.com");
    expect(refused("https://evil.example/client-secret-value")).not.toContain("client-secret-value");
    expect(refused("https://user:secret@advertising-api.amazon.com")).not.toContain("secret");
    expect(refused("advertising-api.amazon.com:443")).not.toContain("443");
    expect(() => amazonAdsClientId({ ...base, user: " " })).toThrow(DatabaseConfigError);
    expect(() => amazonAdsClientId({ ...base, user: "a".repeat(257) })).toThrow(DatabaseConfigError);
    expect(() => amazonAdsClientId({ ...base, user: "has space" })).toThrow(DatabaseConfigError);
    expect(() => amazonAdsClientSecret({ ...base, password: "" })).toThrow(DatabaseConfigError);
    expect(() => amazonAdsClientSecret({ ...base, password: "sec\nret" })).toThrow(DatabaseConfigError);
    expect(() => amazonAdsRefreshToken({ ...base, database: "" })).toThrow(DatabaseConfigError);
    expect(() => amazonAdsRefreshToken({ ...base, database: "r".repeat(2049) })).toThrow(DatabaseConfigError);
    expect(() => amazonAdsProfileId({ ...base, schema: "" })).toThrow(DatabaseConfigError);
    expect(() => amazonAdsProfileId({ ...base, schema: "0123" })).toThrow(DatabaseConfigError);
    const badProfile = (): string => {
      try {
        amazonAdsProfileId({ ...base, schema: "12 secret" });
        return "";
      } catch (error) {
        return (error as Error).message;
      }
    };
    expect(badProfile()).not.toContain("secret");
    expect(() => amazonAdsProfileId({ ...base, schema: "1".repeat(21) })).toThrow(DatabaseConfigError);
  });
});
