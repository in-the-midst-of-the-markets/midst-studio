/**
 * The third-party data a signed-in account can subscribe to.
 *
 * The catalog is operator configuration (`MARKETPLACE_OFFERINGS`). Each database has its own monthly price.
 * `POSTGRES_CONNECTION_STRING`, when set, also lists PostgreSQL at five dollars a month, and
 * `OPEN_SEARCH_CONNECTION_STRING` lists OpenSearch the same way, unless that id is already in the catalog.
 * The connection string stays off the public catalog. A completed Checkout is what grants it: the
 * subscribed database is then saved into that account's connections. A database someone added in the
 * editor is not one of these: the shop reads only these server variables.
 * A personal database connection is never an entry: those are added in the editor, and Stripe does
 * not grant them.
 */

export interface MarketplaceOffering {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** US cents billed every month. 500 is five dollars. Each database sets its own. */
  readonly monthlyCents: number;
  /**
   * The database this subscription opens. Server-only: the public catalog never includes it.
   * Absent for PostgreSQL and OpenSearch, which read their own environment variables.
   */
  readonly connectionString?: string;
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

/** Whether this string is an offering id the catalog would accept. */
export function isMarketplaceOfferingId(value: string): boolean {
  return OFFERING_ID.test(value);
}

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

const CONNECTION_STRING_MAX = 4000;

/** A catalog row's private connection string, or false when the field is present and not usable. */
function connectionStringOf(row: Record<string, unknown>): string | undefined | false {
  if (!Object.hasOwn(row, "connectionString")) return undefined;
  const value = row.connectionString;
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > CONNECTION_STRING_MAX) return false;
  return trimmed;
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
    const connectionString = connectionStringOf(item as unknown as Record<string, unknown>);
    if (connectionString === false) return { ok: false };
    seen.add(item.id);
    offerings.push({
      id: item.id,
      name: item.name,
      description: item.description,
      monthlyCents: item.monthlyCents,
      ...(connectionString === undefined ? {} : { connectionString }),
    });
  }
  return { ok: true, offerings };
}

interface ConnectionOffering {
  readonly env: "POSTGRES_CONNECTION_STRING" | "OPEN_SEARCH_CONNECTION_STRING";
  readonly offering: MarketplaceOffering;
}

/** PostgreSQL and OpenSearch at five dollars a month, each listed when its connection string is set. */
const CONNECTION_OFFERINGS: readonly ConnectionOffering[] = [
  {
    env: "POSTGRES_CONNECTION_STRING",
    offering: { id: "postgres", name: "PostgreSQL", description: "Tables", monthlyCents: 500 },
  },
  {
    env: "OPEN_SEARCH_CONNECTION_STRING",
    offering: { id: "opensearch", name: "OpenSearch", description: "Search indexes", monthlyCents: 500 },
  },
];

/**
 * Whether this environment value is set.
 * A type predicate so a Node `string | undefined` env read narrows before `trim`.
 * `next build` typechecks with Node's process env, where an index read may be undefined.
 */
function isConfigured(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== "";
}

export function readMarketplaceCatalog(env: NodeJS.ProcessEnv = process.env): MarketplaceCatalog {
  const parsed = parseMarketplaceCatalog(env.MARKETPLACE_OFFERINGS);
  if (!parsed.ok) return parsed;
  const listed = new Set(parsed.offerings.map((item) => item.id));
  const extras = CONNECTION_OFFERINGS.flatMap(({ env: key, offering }) =>
    isConfigured(env[key]) && !listed.has(offering.id) ? [offering] : [],
  );
  if (extras.length === 0) return parsed;
  return { ok: true, offerings: [...parsed.offerings, ...extras] };
}

/**
 * The connection string a completed subscription should open.
 * A string on the catalog row wins. PostgreSQL and OpenSearch otherwise use their environment variables.
 */
export function connectionStringForOffering(
  offering: MarketplaceOffering,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (offering.connectionString !== undefined) return offering.connectionString;
  const listed = CONNECTION_OFFERINGS.find((item) => item.offering.id === offering.id);
  if (listed === undefined) return null;
  const value = env[listed.env];
  return isConfigured(value) ? value.trim() : null;
}

export function publicMarketplaceOfferings(offerings: readonly MarketplaceOffering[]): PublicMarketplaceOffering[] {
  return offerings.map(({ id, name, description, monthlyCents }) => ({
    id,
    name,
    description,
    priceLabel: monthlyPriceLabel(monthlyCents),
  }));
}
