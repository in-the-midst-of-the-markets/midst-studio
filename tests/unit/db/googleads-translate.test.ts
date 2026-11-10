import { generateKeyPairSync } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { AuthenticationError, ConnectionError, DatabaseConfigError, QueryError } from "@/lib/db/errors";
import type { NodeRequest, NodeTransport } from "@/lib/db/http/node-transport";
import {
  adsApiHost,
  adsCustomerId,
  adsManagerId,
  adsTokenForm,
  exchangeAdsToken,
  readAdsCredential,
  readAdsTokenGrant,
  type AdsServiceAccount,
} from "@/lib/db/providers/sql/googleads/auth";
import { GOOGLEADS_SQL_GRAMMAR } from "@/lib/db/providers/sql/googleads/sql-grammar";
import {
  GOOGLE_ADS_ROW_CAP,
  googleAdsQuery,
  googleAdsResource,
  translateGoogleAdsSql,
} from "@/lib/db/providers/sql/googleads/translate";
import type { DatabaseConnection } from "@/lib/types";

const base = {
  id: "ads",
  name: "ads",
  type: "googleads",
  host: "googleads.googleapis.com",
  database: "123-456-7890",
  password: "access-token-value",
  createdAt: new Date(0),
} as DatabaseConnection;

const key = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();

const account = {
  kind: "service_account",
  clientEmail: "ads@project.iam.gserviceaccount.com",
  privateKey: key,
} satisfies AdsServiceAccount;

function gaql(sql: string): string {
  return googleAdsQuery(translateGoogleAdsSql(sql), sql);
}

function scripted(status: number, text: string): NodeTransport {
  return {
    request(_request: NodeRequest) {
      return Promise.resolve({ status, contentType: "application/json", retryAfter: null, text });
    },
    close() {},
  };
}

describe("Google Ads SQL", () => {
  test("compiles one search and refuses a write before a request", () => {
    expect(
      gaql(
        "SELECT campaign.name, metrics.clicks FROM campaign WHERE campaign.status = 'ENABLED' ORDER BY metrics.clicks DESC LIMIT 100",
      ),
    ).toBe(
      "SELECT campaign.name, metrics.clicks FROM campaign WHERE campaign.status = 'ENABLED' ORDER BY metrics.clicks DESC LIMIT 100",
    );
    expect(gaql("select * from Customer")).toContain("customer.descriptive_name");
    expect(gaql("select * from Customer")).toContain("FROM customer LIMIT 100");
    expect(gaql("SELECT campaign.name FROM campaign WHERE campaign.name LIKE 'O''Brien%'")).toBe(
      "SELECT campaign.name FROM campaign WHERE campaign.name LIKE 'O''Brien%' LIMIT 100",
    );
    expect(gaql("SELECT metrics.clicks FROM campaign WHERE metrics.clicks >= -1 AND metrics.ctr < 0.5")).toBe(
      "SELECT metrics.clicks FROM campaign WHERE metrics.clicks >= -1 AND metrics.ctr < 0.5 LIMIT 100",
    );
    expect(gaql("SELECT segments.date FROM campaign WHERE segments.date = '2024-02-29'")).toContain(
      "segments.date = '2024-02-29'",
    );
    expect(gaql("SELECT campaign.id FROM campaign WHERE campaign.id IS NULL")).toContain("campaign.id IS NULL");
    expect(gaql("SELECT campaign.id FROM campaign WHERE campaign.id IS NOT NULL")).toContain("IS NOT NULL");
    expect(
      gaql("SELECT campaign.status FROM campaign WHERE campaign.status <> 'REMOVED' ORDER BY campaign.name ASC"),
    ).toContain("campaign.status != 'REMOVED' ORDER BY campaign.name LIMIT");
    expect(gaql("SELECT campaign.id FROM campaign;")).toContain("FROM campaign LIMIT 100");
    expect(gaql('-- note\nSELECT /* keep */ "campaign.name" FROM campaign')).toContain("campaign.name");
    const capped = translateGoogleAdsSql(`SELECT campaign.id FROM campaign LIMIT ${GOOGLE_ADS_ROW_CAP + 1}`);
    expect(capped.capped).toBe(true);
    expect(capped.limit).toBe(GOOGLE_ADS_ROW_CAP);
    const paged = translateGoogleAdsSql("SELECT campaign.id FROM campaign LIMIT 50 OFFSET 980");
    expect(paged.capped).toBe(true);
    expect(gaql("SELECT campaign.id FROM campaign LIMIT 50 OFFSET 980")).toContain("LIMIT 1000");
    const writes = [
      "",
      "DELETE FROM campaign",
      "SELECT DISTINCT campaign.id FROM campaign",
      "SELECT COUNT(*) FROM campaign",
      "SELECT campaign.id FROM campaign; SELECT campaign.id FROM campaign",
      "SELECT campaign.id FROM missing",
      "SELECT nope FROM campaign",
      "SELECT campaign.id FROM campaign WHERE missing = 'a'",
      "SELECT campaign.id FROM campaign WHERE campaign.name OR campaign.id IS NULL",
      "SELECT campaign.id FROM campaign ORDER BY",
      "SELECT campaign.id FROM campaign ORDER BY campaign.id, campaign.name",
      "SELECT campaign.id FROM campaign LIMIT 0",
      "SELECT campaign.id FROM campaign LIMIT 1.5",
      "SELECT campaign.id FROM campaign OFFSET -1",
      "SELECT campaign.id FROM campaign OFFSET 1.5",
      "SELECT campaign.id FROM campaign OFFSET 9007199254740993",
      "SELECT campaign.id",
      "SELECT campaign.id FROM campaign WHERE metrics.clicks LIKE '1'",
      "SELECT campaign.id FROM campaign WHERE segments.date = 1",
      "SELECT campaign.id FROM campaign WHERE campaign.name = 1",
      "SELECT campaign.id FROM campaign WHERE segments.date = 'yesterday'",
      "SELECT campaign.id FROM campaign WHERE segments.date = '2026-00-01'",
      "SELECT campaign.id FROM campaign WHERE segments.date = '2026-13-01'",
      "SELECT campaign.id FROM campaign WHERE segments.date = '2026-01-00'",
      "SELECT campaign.id FROM campaign WHERE segments.date = '2026-02-29'",
      "SELECT campaign.id FROM campaign WHERE segments.date = '2026-04-31'",
      "SELECT @",
      "SELECT 1 FROM campaign",
      "SELECT - FROM campaign",
      "SELECT 1. FROM campaign",
      "SELECT campaign.id FROM campaign WHERE campaign.id ! 1",
      "SELECT /*",
      "SELECT 'open",
      'SELECT "open',
      `SELECT "${"a".repeat(81)}" FROM campaign`,
      'SELECT "a b" FROM campaign',
      'SELECT "camp""aign.name" FROM campaign',
      "SELECT campaign.id FROM campaign WHERE campaign.name AND campaign.id IS NULL",
      "SELECT campaign.id FROM campaign WHERE campaign.name IS NOT GONE",
      "SELECT campaign.id FROM campaign WHERE campaign.name 'x'",
      "SELECT campaign.id FROM campaign WITH",
      "SELECT campaign.id FROM campaign JOIN ad_group",
    ];
    for (const sql of writes) {
      expect(() => gaql(sql)).toThrow(QueryError);
    }
    const campaign = googleAdsResource("campaign");
    if (campaign === undefined) throw new Error("campaign");
    expect(() =>
      googleAdsQuery(
        {
          kind: "select",
          resource: campaign,
          columns: ["nope"],
          filters: [],
          orderBy: null,
          limit: 1,
          offset: 0,
          capped: false,
        },
        "sql",
      ),
    ).toThrow(/nope/);
    expect(() =>
      googleAdsQuery(
        {
          kind: "select",
          resource: campaign,
          columns: null,
          filters: [{ field: "missing", operator: "=", value: "1" }],
          orderBy: null,
          limit: 1,
          offset: 0,
          capped: false,
        },
        "sql",
      ),
    ).toThrow(/missing/);
    const format = GOOGLEADS_SQL_GRAMMAR.completion.formatSegment;
    const read = GOOGLEADS_SQL_GRAMMAR.completion.readQuotedQualifier;
    if (format === null || read === null) throw new Error("completion");
    expect(format('a"b')).toBe('"a""b"');
    expect(read('"campaign.name".')).toBe("campaign.name");
    expect(GOOGLEADS_SQL_GRAMMAR.grammar.completionWords?.lists).toBe("only");
    expect(GOOGLEADS_SQL_GRAMMAR.completion.nameIsDottedWord).toBe(true);
  });
});

describe("Google Ads credentials", () => {
  test("reads a token, a manager id and a service-account key", async () => {
    expect(adsApiHost({ ...base, host: "" })).toBe("googleads.googleapis.com");
    expect(adsApiHost({ ...base, host: " https://GoogleAds.googleapis.com. " })).toBe("googleads.googleapis.com");
    expect(adsCustomerId(base)).toBe("1234567890");
    expect(adsManagerId(base)).toBeNull();
    expect(adsManagerId({ ...base, user: "123-456-7891" })).toBe("1234567891");
    expect(readAdsCredential(" Bearer access-token-value ")).toEqual({
      kind: "access_token",
      token: "access-token-value",
    });
    expect(
      readAdsCredential(JSON.stringify({ client_email: account.clientEmail, private_key: "BEGIN PRIVATE KEY" })),
    ).toEqual({
      kind: "service_account",
      clientEmail: account.clientEmail,
      privateKey: "BEGIN PRIVATE KEY",
    });
    const form = await adsTokenForm(account, 1_700_000_000_000);
    expect(form.grant_type).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    expect(form.assertion.split(".")).toHaveLength(3);
    const issued = readAdsTokenGrant(200, JSON.stringify({ access_token: "issued-token", expires_in: 3600 }), 1_000);
    expect(issued).toEqual({ token: "issued-token", expiresAt: 1_000 + 3540 * 1000 });
    expect(
      readAdsTokenGrant(200, JSON.stringify({ access_token: "issued-token", expires_in: 30 }), 1_000).expiresAt,
    ).toBe(1_000);
    expect(readAdsTokenGrant(200, JSON.stringify({ access_token: "issued-token" }), 1_000).expiresAt).toBe(1_000);
    const exchanged = await exchangeAdsToken(
      account,
      scripted(200, JSON.stringify({ access_token: "from-exchange", expires_in: 120 })),
      5_000,
    );
    expect(exchanged.token).toBe("from-exchange");
    await expect(exchangeAdsToken(account, scripted(302, ""), 5_000)).rejects.toThrow(ConnectionError);
  });

  test("refuses a bad host, customer id or key without repeating the secret", async () => {
    const hosts = [
      "https://evil.example",
      "https://analyticsdata.googleapis.com",
      "https://user:secret@googleads.googleapis.com",
      "not a host",
    ];
    for (const host of hosts) {
      expect(() => adsApiHost({ ...base, host })).toThrow(DatabaseConfigError);
      try {
        adsApiHost({ ...base, host });
      } catch (error) {
        expect(error instanceof Error ? error.message : "").not.toContain("evil.example");
        expect(error instanceof Error ? error.message : "").not.toContain("secret");
      }
    }
    expect(() => adsCustomerId({ ...base, database: "   " })).toThrow(/required/);
    expect(() => adsCustomerId({ ...base, database: "123" })).toThrow(/10 digits/);
    expect(() => adsManagerId({ ...base, user: "manager" })).toThrow(/10 digits/);
    expect(() => readAdsCredential("  ")).toThrow(/required/);
    expect(() => readAdsCredential("has space")).toThrow(/single line/);
    expect(() => readAdsCredential("x".repeat(16_001))).toThrow(/larger/);
    expect(() => readAdsCredential("{")).toThrow(/JSON/);
    expect(() => readAdsCredential('{"nope":1}')).toThrow(/JSON/);
    expect(() =>
      readAdsCredential(JSON.stringify({ client_email: "not-an-email", private_key: "BEGIN PRIVATE KEY" })),
    ).toThrow(/JSON/);
    expect(() =>
      readAdsCredential(JSON.stringify({ client_email: `${"a".repeat(250)}@b.co`, private_key: "BEGIN PRIVATE KEY" })),
    ).toThrow(/JSON/);
    expect(() => readAdsCredential(JSON.stringify({ client_email: "a@b.co", private_key: "no" }))).toThrow(/JSON/);
    expect(() => readAdsCredential(JSON.stringify({ private_key: "BEGIN PRIVATE KEY" }))).toThrow(/JSON/);
    await expect(adsTokenForm({ ...account, privateKey: "BEGIN PRIVATE KEY" }, 0)).rejects.toThrow(AuthenticationError);
    expect(() =>
      readAdsTokenGrant(400, JSON.stringify({ error_description: "access-token-value denied" }), 0, [
        "access-token-value",
      ]),
    ).toThrow(/••••/);
    expect(() => readAdsTokenGrant(400, JSON.stringify({ error: "nope" }), 0)).toThrow(/nope/);
    expect(() => readAdsTokenGrant(400, JSON.stringify({ error: { code: 1 } }), 0)).toThrow(/HTTP 400/);
    expect(() => readAdsTokenGrant(400, "[]", 0)).toThrow(/HTTP 400/);
    expect(() => readAdsTokenGrant(400, "", 0)).toThrow(/HTTP 400/);
    expect(() => readAdsTokenGrant(400, "not-json-but-a-reason", 0)).toThrow(/HTTP 400/);
    expect(() => readAdsTokenGrant(200, JSON.stringify({ access_token: "has space" }), 0)).toThrow(AuthenticationError);
    expect(() => readAdsTokenGrant(200, JSON.stringify({ access_token: "y".repeat(8001) }), 0)).toThrow(
      AuthenticationError,
    );
    expect(() => readAdsTokenGrant(400, JSON.stringify({ error_description: "z".repeat(400) }), 0)).toThrow(
      AuthenticationError,
    );
  });
});
