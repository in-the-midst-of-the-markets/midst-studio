/**
 * The SQL subset an Amazon Ads connection runs.
 *
 * Amazon Ads is an advertising API, not a SQL server. One SELECT is one Sponsored Products list.
 * The filter, the order and the page are applied to that answer. A write, a join and a second
 * statement fail here, before a request. The next page is not requested.
 */
import { QueryError } from "@/lib/db/errors";
import {
  listedResource,
  listedRows,
  translateListedSql,
  type ListedColumn,
  type ListedProduct,
  type ListedResource,
  type ListedSelect,
} from "../listed-select";

/** One list page. The API allows at most 100, and Studio does not follow `nextToken`. */
export const AMAZON_ADS_ROW_CAP = 100;

export type AmazonAdsColumn = ListedColumn;
export type AmazonAdsResource = ListedResource;
export type AmazonAdsSelect = ListedSelect;

interface AmazonAdsList {
  readonly media: string;
  readonly rows: string;
}

function column(name: string, type: AmazonAdsColumn["type"], json: string): AmazonAdsColumn {
  return { name, type, json };
}

function resource(name: string, primary: string, path: string, columns: readonly AmazonAdsColumn[]): AmazonAdsResource {
  return { name, primary, path, columns };
}

/** The Sponsored Products lists this connection reads. */
export const AMAZON_ADS_RESOURCES: readonly AmazonAdsResource[] = Object.freeze([
  resource("campaign", "campaign.campaign_id", "/sp/campaigns/list", [
    column("campaign.campaign_id", "text", "campaignId"),
    column("campaign.name", "text", "name"),
    column("campaign.state", "text", "state"),
    column("campaign.targeting_type", "text", "targetingType"),
    column("campaign.budget", "number", "budgetAmount"),
    column("campaign.budget_type", "text", "budgetType"),
    column("campaign.start_date", "text", "startDate"),
  ]),
  resource("ad_group", "ad_group.ad_group_id", "/sp/adGroups/list", [
    column("ad_group.ad_group_id", "text", "adGroupId"),
    column("ad_group.name", "text", "name"),
    column("ad_group.state", "text", "state"),
    column("campaign.campaign_id", "text", "campaignId"),
    column("ad_group.default_bid", "number", "defaultBid"),
  ]),
  resource("product_ad", "product_ad.ad_id", "/sp/productAds/list", [
    column("product_ad.ad_id", "text", "adId"),
    column("product_ad.state", "text", "state"),
    column("product_ad.asin", "text", "asin"),
    column("product_ad.sku", "text", "sku"),
    column("ad_group.ad_group_id", "text", "adGroupId"),
    column("campaign.campaign_id", "text", "campaignId"),
  ]),
]);

const LISTS: Readonly<Record<string, AmazonAdsList>> = {
  campaign: { media: "application/vnd.spCampaign.v3+json", rows: "campaigns" },
  ad_group: { media: "application/vnd.spAdGroup.v3+json", rows: "adGroups" },
  product_ad: { media: "application/vnd.spProductAd.v3+json", rows: "productAds" },
};

const AMAZON_ADS: ListedProduct = {
  provider: "amazonads",
  rowCap: AMAZON_ADS_ROW_CAP,
  resources: AMAZON_ADS_RESOURCES,
  product: "Amazon Ads",
  example: "campaign",
  exampleColumn: "campaign.name",
};

export function amazonAdsResource(name: string): AmazonAdsResource | undefined {
  return listedResource(AMAZON_ADS, name);
}

/** The vendor media type and the array key for one resource. An unknown name is a query error. */
export function amazonAdsList(name: string): AmazonAdsList {
  const found = LISTS[name];
  if (found === undefined) throw new QueryError("Amazon Ads has no table with that name.", "amazonads");
  return found;
}

/** One statement, or a refusal that names what to write instead. */
export function translateAmazonAdsSql(sql: string): AmazonAdsSelect {
  return translateListedSql(sql, AMAZON_ADS);
}

const AMOUNT = /^-?\d+(\.\d+)?$/;

function amount(value: unknown): unknown {
  if (typeof value === "number") return value;
  if (typeof value !== "string" || !AMOUNT.test(value)) return value;
  return Number(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One advertising object, with the budget object opened into the columns the grid shows. */
function flatten(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const flat: Record<string, unknown> = { ...value };
  if (isRecord(value.budget)) {
    flat.budgetAmount = amount(value.budget.budget);
    flat.budgetType = value.budget.budgetType;
  }
  for (const key of ["campaignId", "adGroupId", "adId"] as const) {
    const id = flat[key];
    if (typeof id === "number" && Number.isFinite(id)) flat[key] = String(id);
  }
  if (typeof flat.budgetAmount === "string") flat.budgetAmount = amount(flat.budgetAmount);
  if (typeof flat.defaultBid === "string") flat.defaultBid = amount(flat.defaultBid);
  return flat;
}

/** The page of rows one Sponsored Products list becomes. */
export function amazonAdsRows(
  statement: AmazonAdsSelect,
  entries: readonly unknown[],
  sql: string,
): Record<string, unknown>[] {
  return listedRows(AMAZON_ADS, statement, entries.map(flatten), sql);
}
