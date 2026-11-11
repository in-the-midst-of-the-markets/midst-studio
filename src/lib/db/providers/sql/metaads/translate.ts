/**
 * The SQL subset a Meta Ads connection runs.
 *
 * Meta Ads is a Marketing API, not a SQL server. The editor still speaks SQL, and this module
 * turns one SELECT into one Graph API v27.0 list of one standard resource. Filters, order and
 * the page are applied to that answer. A write, a join and a second statement fail here, before
 * a request. Reporting metrics and the next page are not requested.
 */
import {
  listedResource,
  listedRows,
  translateListedSql,
  type ListedColumn,
  type ListedProduct,
  type ListedResource,
  type ListedSelect,
} from "../listed-select";

/** One list page. Studio asks for 1000 rows and does not follow `paging.next`. */
export const META_ADS_ROW_CAP = 1000;

export const META_GRAPH_VERSION = "v27.0";

export type MetaAdsType = ListedColumn["type"];
export type MetaAdsColumn = ListedColumn;
export type MetaAdsResource = ListedResource;
export type MetaAdsSelect = ListedSelect;

function column(name: string, type: MetaAdsType, json: string): MetaAdsColumn {
  return { name, type, json };
}

function resource(name: string, primary: string, path: string, columns: readonly MetaAdsColumn[]): MetaAdsResource {
  return { name, primary, path, columns };
}

/** The standard resources this connection reads. Each one is one Graph API v27.0 edge. */
export const META_ADS_RESOURCES: readonly MetaAdsResource[] = Object.freeze([
  resource("campaign", "campaign.id", "/campaigns", [
    column("campaign.id", "text", "id"),
    column("campaign.name", "text", "name"),
    column("campaign.status", "text", "status"),
    column("campaign.objective", "text", "objective"),
    column("campaign.daily_budget", "number", "daily_budget"),
    column("campaign.lifetime_budget", "number", "lifetime_budget"),
    column("campaign.updated_time", "text", "updated_time"),
  ]),
  resource("ad_set", "ad_set.id", "/adsets", [
    column("ad_set.id", "text", "id"),
    column("ad_set.name", "text", "name"),
    column("ad_set.status", "text", "status"),
    column("campaign.id", "text", "campaign_id"),
    column("ad_set.daily_budget", "number", "daily_budget"),
    column("ad_set.lifetime_budget", "number", "lifetime_budget"),
    column("ad_set.updated_time", "text", "updated_time"),
  ]),
  resource("ad", "ad.id", "/ads", [
    column("ad.id", "text", "id"),
    column("ad.name", "text", "name"),
    column("ad.status", "text", "status"),
    column("ad_set.id", "text", "adset_id"),
    column("campaign.id", "text", "campaign_id"),
    column("ad.updated_time", "text", "updated_time"),
  ]),
]);

const META_ADS: ListedProduct = {
  provider: "metaads",
  rowCap: META_ADS_ROW_CAP,
  resources: META_ADS_RESOURCES,
  product: "Meta Ads",
  example: "campaign",
  exampleColumn: "campaign.name",
};

export function metaAdsResource(name: string): MetaAdsResource | undefined {
  return listedResource(META_ADS, name);
}

/** One statement, or a refusal that names what to write instead. */
export function translateMetaAdsSql(sql: string): MetaAdsSelect {
  return translateListedSql(sql, META_ADS);
}

const AMOUNT = /^-?\d+(\.\d+)?$/;

/** A budget the Graph API returns as text becomes the number the column declares. */
function amount(value: unknown): unknown {
  if (typeof value === "number") return value;
  if (typeof value !== "string" || !AMOUNT.test(value)) return value;
  return Number(value);
}

function withAmounts(statement: MetaAdsSelect, entries: readonly unknown[]): unknown[] {
  const keys = statement.resource.columns.filter((item) => item.type === "number").map((item) => item.json);
  if (keys.length === 0) return [...entries];
  return entries.map((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return entry;
    const next: Record<string, unknown> = { ...entry };
    for (const key of keys) next[key] = amount(next[key]);
    return next;
  });
}

/** The page of rows one Graph API list becomes. */
export function metaAdsRows(
  statement: MetaAdsSelect,
  entries: readonly unknown[],
  sql: string,
): Record<string, unknown>[] {
  return listedRows(META_ADS, statement, withAmounts(statement, entries), sql);
}
