/**
 * The SQL subset a TikTok Ads connection runs.
 *
 * TikTok Ads is a Marketing API, not a SQL server. The editor still speaks SQL, and this module
 * turns one SELECT into one API v1.3 list of one standard resource. Filters, order and the
 * page are applied to that answer. A write, a join and a second statement fail here, before
 * a request. Reporting metrics and the next page are not requested.
 */
import {
  listedResource,
  listedRows,
  translateListedSql,
  type ListedColumn,
  type ListedCompare,
  type ListedFilter,
  type ListedOrder,
  type ListedProduct,
  type ListedResource,
  type ListedSelect,
} from "../listed-select";

/** One list page. The Marketing API's maximum `page_size` is 1000, and Studio does not request page 2. */
export const TIKTOK_ADS_ROW_CAP = 1000;

export type TikTokAdsType = ListedColumn["type"];
export type TikTokAdsColumn = ListedColumn;
export type TikTokAdsResource = ListedResource;
export type TikTokAdsCompare = ListedCompare;
export type TikTokAdsFilter = ListedFilter;
export type TikTokAdsOrder = ListedOrder;
export type TikTokAdsSelect = ListedSelect;

function column(name: string, type: TikTokAdsType, json: string): TikTokAdsColumn {
  return { name, type, json };
}

function resource(name: string, primary: string, path: string, columns: readonly TikTokAdsColumn[]): TikTokAdsResource {
  return { name, primary, path, columns };
}

/** The standard resources this connection reads. Each one is one Marketing API v1.3 list. */
export const TIKTOK_ADS_RESOURCES: readonly TikTokAdsResource[] = Object.freeze([
  resource("campaign", "campaign.id", "/open_api/v1.3/campaign/get/", [
    column("campaign.id", "text", "campaign_id"),
    column("campaign.name", "text", "campaign_name"),
    column("campaign.operation_status", "text", "operation_status"),
    column("campaign.objective_type", "text", "objective_type"),
    column("campaign.budget_mode", "text", "budget_mode"),
    column("campaign.budget", "number", "budget"),
    column("campaign.modify_time", "text", "modify_time"),
  ]),
  resource("ad_group", "ad_group.id", "/open_api/v1.3/adgroup/get/", [
    column("ad_group.id", "text", "adgroup_id"),
    column("ad_group.name", "text", "adgroup_name"),
    column("ad_group.operation_status", "text", "operation_status"),
    column("campaign.id", "text", "campaign_id"),
    column("ad_group.budget", "number", "budget"),
    column("ad_group.modify_time", "text", "modify_time"),
  ]),
  resource("ad", "ad.id", "/open_api/v1.3/ad/get/", [
    column("ad.id", "text", "ad_id"),
    column("ad.name", "text", "ad_name"),
    column("ad.operation_status", "text", "operation_status"),
    column("ad_group.id", "text", "adgroup_id"),
    column("campaign.id", "text", "campaign_id"),
    column("ad.modify_time", "text", "modify_time"),
  ]),
]);

const TIKTOK_ADS: ListedProduct = {
  provider: "tiktokads",
  rowCap: TIKTOK_ADS_ROW_CAP,
  resources: TIKTOK_ADS_RESOURCES,
  product: "TikTok Ads",
  example: "campaign",
  exampleColumn: "campaign.name",
};

export function tiktokAdsResource(name: string): TikTokAdsResource | undefined {
  return listedResource(TIKTOK_ADS, name);
}

/** One statement, or a refusal that names what to write instead. */
export function translateTikTokAdsSql(sql: string): TikTokAdsSelect {
  return translateListedSql(sql, TIKTOK_ADS);
}

/** The page of rows one Marketing API list becomes. */
export function tiktokAdsRows(
  statement: TikTokAdsSelect,
  entries: readonly unknown[],
  sql: string,
): Record<string, unknown>[] {
  return listedRows(TIKTOK_ADS, statement, entries, sql);
}
