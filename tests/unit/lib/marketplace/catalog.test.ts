import { afterEach, describe, expect, test } from "bun:test";
import {
  parseMarketplaceCatalog,
  publicMarketplaceOfferings,
  readMarketplaceCatalog,
  type MarketplaceOffering,
} from "@/lib/marketplace/catalog";

const OFFERING: MarketplaceOffering = {
  id: "acme-trades",
  name: "Acme Trades",
  description: "Tick history",
  priceId: "price_abc",
  priceLabel: "$49/month",
};

const original = process.env.MARKETPLACE_OFFERINGS;

afterEach(() => {
  if (original === undefined) delete process.env.MARKETPLACE_OFFERINGS;
  else process.env.MARKETPLACE_OFFERINGS = original;
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
    [{ ...OFFERING, priceId: "prod_abc" }],
    [{ ...OFFERING, priceId: "price_" }],
    [{ ...OFFERING, priceId: 1 }],
    [{ ...OFFERING, priceLabel: "   " }],
    [{ ...OFFERING, priceLabel: "p".repeat(41) }],
    [{ ...OFFERING, priceLabel: 1 }],
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

  test("accepts a one-character id and a name at the length limit", () => {
    const offering = { ...OFFERING, id: "a", name: "n".repeat(80), description: "", priceLabel: "$1" };

    expect(parseMarketplaceCatalog(JSON.stringify([offering]))).toEqual({ ok: true, offerings: [offering] });
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
});

describe("publicMarketplaceOfferings", () => {
  test("strips the Stripe price id", () => {
    expect(publicMarketplaceOfferings([OFFERING])).toEqual([
      { id: OFFERING.id, name: OFFERING.name, description: OFFERING.description, priceLabel: OFFERING.priceLabel },
    ]);
  });
});
