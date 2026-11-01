import { afterEach, describe, expect, test } from "bun:test";
import {
  MONTHLY_CENTS_MAX,
  MONTHLY_CENTS_MIN,
  monthlyPriceLabel,
  parseMarketplaceCatalog,
  publicMarketplaceOfferings,
  readMarketplaceCatalog,
  type MarketplaceOffering,
} from "@/lib/marketplace/catalog";

const OFFERING: MarketplaceOffering = {
  id: "opensearch",
  name: "OpenSearch",
  description: "Search indexes",
  monthlyCents: 500,
};

const original = process.env.MARKETPLACE_OFFERINGS;
const originalConnection = process.env.OPEN_SEARCH_CONNECTION_STRING;

afterEach(() => {
  if (original === undefined) delete process.env.MARKETPLACE_OFFERINGS;
  else process.env.MARKETPLACE_OFFERINGS = original;
  if (originalConnection === undefined) delete process.env.OPEN_SEARCH_CONNECTION_STRING;
  else process.env.OPEN_SEARCH_CONNECTION_STRING = originalConnection;
});

describe("parseMarketplaceCatalog", () => {
  test("an unset or blank value is an empty catalog", () => {
    expect(parseMarketplaceCatalog(undefined)).toEqual({ ok: true, offerings: [] });
    expect(parseMarketplaceCatalog("")).toEqual({ ok: true, offerings: [] });
    expect(parseMarketplaceCatalog("   ")).toEqual({ ok: true, offerings: [] });
  });

  test("refuses JSON that does not parse or is not an array", () => {
    expect(parseMarketplaceCatalog("{")).toEqual({ ok: false });
    expect(parseMarketplaceCatalog("{}")).toEqual({ ok: false });
    expect(parseMarketplaceCatalog("null")).toEqual({ ok: false });
  });

  test.each([
    [null],
    [[]],
    [1],
    [{ ...OFFERING, id: "Acme" }],
    [{ ...OFFERING, id: "-acme" }],
    [{ ...OFFERING, id: "acme-" }],
    [{ ...OFFERING, id: "" }],
    [{ ...OFFERING, name: "   " }],
    [{ ...OFFERING, name: "n".repeat(81) }],
    [{ ...OFFERING, name: 1 }],
    [{ ...OFFERING, description: "d".repeat(401) }],
    [{ ...OFFERING, description: 1 }],
    [{ ...OFFERING, monthlyCents: MONTHLY_CENTS_MIN - 1 }],
    [{ ...OFFERING, monthlyCents: 0 }],
    [{ ...OFFERING, monthlyCents: -500 }],
    [{ ...OFFERING, monthlyCents: 1.5 }],
    [{ ...OFFERING, monthlyCents: "500" }],
    [{ ...OFFERING, monthlyCents: MONTHLY_CENTS_MAX + 1 }],
    [{ ...OFFERING, monthlyCents: Number.NaN }],
  ])("refuses an offering that is not sellable (%j)", (item) => {
    expect(parseMarketplaceCatalog(JSON.stringify([item]))).toEqual({ ok: false });
  });

  test("refuses a repeated id", () => {
    expect(parseMarketplaceCatalog(JSON.stringify([OFFERING, OFFERING]))).toEqual({ ok: false });
  });

  test("keeps a valid offering and drops anything else on the row", () => {
    const parsed = parseMarketplaceCatalog(JSON.stringify([{ ...OFFERING, secret: "no" }]));

    expect(parsed).toEqual({ ok: true, offerings: [OFFERING] });
  });

  test("accepts a one-character id, a name at the length limit, and the price bounds", () => {
    const named = { ...OFFERING, id: "a", name: "n".repeat(80), description: "", monthlyCents: 100 };
    expect(parseMarketplaceCatalog(JSON.stringify([named]))).toEqual({ ok: true, offerings: [named] });

    for (const monthlyCents of [MONTHLY_CENTS_MIN, MONTHLY_CENTS_MAX]) {
      const priced = { ...OFFERING, monthlyCents };
      expect(parseMarketplaceCatalog(JSON.stringify([priced]))).toEqual({ ok: true, offerings: [priced] });
    }
  });
});

describe("readMarketplaceCatalog", () => {
  test("reads MARKETPLACE_OFFERINGS from the environment it is given", () => {
    expect(readMarketplaceCatalog({ ...process.env, MARKETPLACE_OFFERINGS: JSON.stringify([OFFERING]) })).toEqual({
      ok: true,
      offerings: [OFFERING],
    });
  });

  test("reads process.env when no environment is passed", () => {
    process.env.MARKETPLACE_OFFERINGS = JSON.stringify([OFFERING]);

    expect(readMarketplaceCatalog()).toEqual({ ok: true, offerings: [OFFERING] });
  });

  test("lists OpenSearch when its connection string is set and the catalog JSON is empty", () => {
    expect(
      readMarketplaceCatalog({
        ...process.env,
        MARKETPLACE_OFFERINGS: undefined,
        OPEN_SEARCH_CONNECTION_STRING: "https://search.example:9200",
      }),
    ).toEqual({
      ok: true,
      offerings: [OFFERING],
    });
    delete process.env.MARKETPLACE_OFFERINGS;
    process.env.OPEN_SEARCH_CONNECTION_STRING = "https://search.example:9200";

    expect(readMarketplaceCatalog()).toEqual({ ok: true, offerings: [OFFERING] });
  });

  test("a blank connection string does not list OpenSearch", () => {
    expect(
      readMarketplaceCatalog({
        ...process.env,
        MARKETPLACE_OFFERINGS: undefined,
        OPEN_SEARCH_CONNECTION_STRING: "   ",
      }),
    ).toEqual({ ok: true, offerings: [] });
    expect(
      readMarketplaceCatalog({
        ...process.env,
        MARKETPLACE_OFFERINGS: undefined,
        OPEN_SEARCH_CONNECTION_STRING: undefined,
      }),
    ).toEqual({ ok: true, offerings: [] });
  });

  test("keeps a catalogued OpenSearch row instead of adding another", () => {
    const priced = { ...OFFERING, monthlyCents: 800, description: "Operator copy" };

    expect(
      readMarketplaceCatalog({
        ...process.env,
        MARKETPLACE_OFFERINGS: JSON.stringify([priced]),
        OPEN_SEARCH_CONNECTION_STRING: "https://user:secret-token@search.example:9200",
      }),
    ).toEqual({ ok: true, offerings: [priced] });
  });

  test("appends OpenSearch after other offerings and leaves the connection string out", () => {
    const postgres: MarketplaceOffering = {
      id: "postgres",
      name: "PostgreSQL",
      description: "Tables",
      monthlyCents: 1200,
    };
    const secret = "https://user:secret-token@search.example:9200";
    const catalog = readMarketplaceCatalog({
      ...process.env,
      MARKETPLACE_OFFERINGS: JSON.stringify([postgres]),
      OPEN_SEARCH_CONNECTION_STRING: secret,
    });

    expect(catalog).toEqual({ ok: true, offerings: [postgres, OFFERING] });
    expect(JSON.stringify(catalog)).not.toContain("secret-token");
    if (catalog.ok) {
      expect(JSON.stringify(publicMarketplaceOfferings(catalog.offerings))).not.toContain("secret-token");
    }
  });

  test("a malformed catalog stays a configuration error when the connection string is set", () => {
    expect(
      readMarketplaceCatalog({
        ...process.env,
        MARKETPLACE_OFFERINGS: "{",
        OPEN_SEARCH_CONNECTION_STRING: "https://search.example:9200",
      }),
    ).toEqual({ ok: false });
  });
});

describe("monthlyPriceLabel", () => {
  test("writes whole dollars without cents, and leftover cents with two digits", () => {
    expect(monthlyPriceLabel(500)).toBe("$5/month");
    expect(monthlyPriceLabel(1200)).toBe("$12/month");
    expect(monthlyPriceLabel(50)).toBe("$0.50/month");
    expect(monthlyPriceLabel(550)).toBe("$5.50/month");
  });
});

describe("publicMarketplaceOfferings", () => {
  test("shows each database's own monthly price and not the amount the server charges from", () => {
    const postgres: MarketplaceOffering = {
      id: "postgres",
      name: "PostgreSQL",
      description: "Tables",
      monthlyCents: 1200,
    };

    expect(publicMarketplaceOfferings([OFFERING, postgres])).toEqual([
      { id: "opensearch", name: "OpenSearch", description: "Search indexes", priceLabel: "$5/month" },
      { id: "postgres", name: "PostgreSQL", description: "Tables", priceLabel: "$12/month" },
    ]);
  });
});
