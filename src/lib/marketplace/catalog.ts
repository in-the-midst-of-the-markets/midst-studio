/**
 * The third-party data a signed-in account can subscribe to.
 *
 * The catalog is operator configuration (`MARKETPLACE_OFFERINGS`). Each database has its own monthly price.
 * A personal database connection is never an entry: those are added in the editor, and Stripe does
 * not grant them.
 */

export interface MarketplaceOffering {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** US cents billed every month. 500 is five dollars. Each database sets its own. */
  readonly monthlyCents: number;
}

/** What the browser is allowed to see. The charge stays on the server. */
export interface PublicMarketplaceOffering {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly priceLabel: string;
}

export type MarketplaceCatalog = { ok: true; offerings: readonly MarketplaceOffering[] } | { ok: false };

const OFFERING_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/** Stripe's smallest US-dollar charge, and the largest unit amount Checkout accepts. */
export const MONTHLY_CENTS_MIN = 50;
export const MONTHLY_CENTS_MAX = 99_999_999;

/** The list label for a monthly price, in US dollars. Five hundred cents is "$5/month". */
export function monthlyPriceLabel(cents: number): string {
  const dollars = Math.trunc(cents / 100);
  const remainder = cents % 100;
  const amount = remainder === 0 ? String(dollars) : `${dollars}.${String(remainder).padStart(2, "0")}`;
  return `$${amount}/month`;
}

function isMonthlyCents(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isInteger(value) && value >= MONTHLY_CENTS_MIN && value <= MONTHLY_CENTS_MAX
  );
}

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
    isMonthlyCents(row.monthlyCents)
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
      monthlyCents: item.monthlyCents,
    });
  }
  return { ok: true, offerings };
}

export function readMarketplaceCatalog(env: NodeJS.ProcessEnv = process.env): MarketplaceCatalog {
  return parseMarketplaceCatalog(env.MARKETPLACE_OFFERINGS);
}

export function publicMarketplaceOfferings(offerings: readonly MarketplaceOffering[]): PublicMarketplaceOffering[] {
  return offerings.map(({ id, name, description, monthlyCents }) => ({
    id,
    name,
    description,
    priceLabel: monthlyPriceLabel(monthlyCents),
  }));
}
