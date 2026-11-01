/**
 * The third-party data a signed-in account can subscribe to.
 *
 * The catalog is operator configuration (`MARKETPLACE_OFFERINGS`), one Stripe price per offering.
 * A personal database connection is never an entry: those are added in the editor, and Stripe does
 * not grant them.
 */

export interface MarketplaceOffering {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly priceId: string;
  readonly priceLabel: string;
}

/** What the browser is allowed to see. The Stripe price id stays on the server. */
export interface PublicMarketplaceOffering {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly priceLabel: string;
}

export type MarketplaceCatalog = { ok: true; offerings: readonly MarketplaceOffering[] } | { ok: false };

const OFFERING_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const STRIPE_PRICE_ID = /^price_[A-Za-z0-9]+$/;

/**
 * What Checkout charges for every offering, and what the list shows.
 * Five US dollars, billed each month. A catalog price id is not the charge.
 */
export const MARKETPLACE_SUBSCRIPTION = {
  currency: "usd",
  unitAmount: "500",
  interval: "month",
  label: "$5/month",
} as const;

function isOffering(value: unknown): value is MarketplaceOffering {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.id === "string" &&
    OFFERING_ID.test(row.id) &&
    typeof row.name === "string" &&
    row.name.trim() !== "" &&
    row.name.length <= 80 &&
    typeof row.description === "string" &&
    row.description.length <= 400 &&
    typeof row.priceId === "string" &&
    STRIPE_PRICE_ID.test(row.priceId) &&
    typeof row.priceLabel === "string" &&
    row.priceLabel.trim() !== "" &&
    row.priceLabel.length <= 40
  );
}

/** Parses the catalog JSON. An unset or blank value is an empty catalog; anything malformed is refused. */
export function parseMarketplaceCatalog(raw: string | undefined): MarketplaceCatalog {
  if (raw === undefined || raw.trim() === "") return { ok: true, offerings: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false };
  }
  if (!Array.isArray(parsed)) return { ok: false };
  const offerings: MarketplaceOffering[] = [];
  const seen = new Set<string>();
  for (const item of parsed) {
    if (!isOffering(item) || seen.has(item.id)) return { ok: false };
    seen.add(item.id);
    offerings.push({
      id: item.id,
      name: item.name,
      description: item.description,
      priceId: item.priceId,
      priceLabel: item.priceLabel,
    });
  }
  return { ok: true, offerings };
}

export function readMarketplaceCatalog(env: NodeJS.ProcessEnv = process.env): MarketplaceCatalog {
  return parseMarketplaceCatalog(env.MARKETPLACE_OFFERINGS);
}

export function publicMarketplaceOfferings(offerings: readonly MarketplaceOffering[]): PublicMarketplaceOffering[] {
  return offerings.map(({ id, name, description }) => ({
    id,
    name,
    description,
    priceLabel: MARKETPLACE_SUBSCRIPTION.label,
  }));
}
