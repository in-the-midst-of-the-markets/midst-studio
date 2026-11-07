/**
 * The Stripe objects a read-only connection lists.
 *
 * Columns are the fields the editor names. Stripe has no properties API, so the list is fixed.
 * Amounts are in the smallest currency unit. `created` and the other epoch columns are Unix seconds.
 */
import { QueryError } from "@/lib/db/errors";

const PROVIDER = "stripe" as const;

export type StripeColumnType = "text" | "numeric" | "boolean" | "timestamp";

export interface StripeColumn {
  readonly name: string;
  readonly type: StripeColumnType;
  /** A Unix-seconds value, rendered as an ISO timestamp. */
  readonly epoch?: boolean;
}

export interface StripeFilter {
  readonly column: string;
  readonly op: "EQ" | "NEQ" | "LT" | "LTE" | "GT" | "GTE";
  readonly value: string | number | boolean;
}

export interface StripeObject {
  readonly name: string;
  readonly search: boolean;
  /** Equality filters the list endpoint accepts, besides a range on `created`. */
  readonly listFilters: readonly string[];
  /** Fields the search endpoint accepts, besides a range on `created`. */
  readonly searchFields: readonly string[];
  readonly columns: readonly StripeColumn[];
}

const text = (name: string): StripeColumn => ({ name, type: "text" });
const number = (name: string): StripeColumn => ({ name, type: "numeric" });
const bool = (name: string): StripeColumn => ({ name, type: "boolean" });
const epoch = (name: string): StripeColumn => ({ name, type: "timestamp", epoch: true });

export const STRIPE_OBJECTS: readonly StripeObject[] = [
  {
    name: "customers",
    search: true,
    listFilters: ["email"],
    searchFields: ["email", "name", "phone"],
    columns: [
      text("email"),
      text("name"),
      text("description"),
      text("phone"),
      text("currency"),
      bool("delinquent"),
      epoch("created"),
    ],
  },
  {
    name: "charges",
    search: true,
    listFilters: ["customer"],
    searchFields: ["customer", "status", "currency", "amount"],
    columns: [
      number("amount"),
      text("currency"),
      text("status"),
      bool("paid"),
      text("customer"),
      text("description"),
      epoch("created"),
    ],
  },
  {
    name: "payment_intents",
    search: true,
    listFilters: ["customer"],
    searchFields: ["customer", "status", "currency", "amount"],
    columns: [
      number("amount"),
      text("currency"),
      text("status"),
      text("customer"),
      text("description"),
      epoch("created"),
    ],
  },
  {
    name: "invoices",
    search: true,
    listFilters: ["customer", "status", "subscription"],
    searchFields: ["customer", "status", "subscription", "currency", "number", "total"],
    columns: [
      text("number"),
      text("customer"),
      text("status"),
      text("currency"),
      number("total"),
      number("amount_due"),
      epoch("created"),
    ],
  },
  {
    name: "subscriptions",
    search: true,
    listFilters: ["customer", "status", "price"],
    searchFields: ["customer", "status"],
    columns: [
      text("customer"),
      text("status"),
      text("currency"),
      epoch("created"),
      epoch("current_period_end"),
      bool("cancel_at_period_end"),
    ],
  },
  {
    name: "products",
    search: true,
    listFilters: ["active"],
    searchFields: ["name", "active"],
    columns: [text("name"), text("description"), bool("active"), epoch("created")],
  },
  {
    name: "prices",
    search: true,
    listFilters: ["product", "active", "type"],
    searchFields: ["product", "active", "type", "currency"],
    columns: [text("product"), text("currency"), number("unit_amount"), bool("active"), text("type"), epoch("created")],
  },
  {
    name: "refunds",
    search: false,
    listFilters: ["charge"],
    searchFields: [],
    columns: [number("amount"), text("currency"), text("charge"), text("status"), text("reason"), epoch("created")],
  },
  {
    name: "payouts",
    search: false,
    listFilters: ["status"],
    searchFields: [],
    columns: [
      number("amount"),
      text("currency"),
      text("status"),
      epoch("arrival_date"),
      text("description"),
      epoch("created"),
    ],
  },
  {
    name: "balance_transactions",
    search: false,
    listFilters: ["type", "payout"],
    searchFields: [],
    columns: [
      number("amount"),
      text("currency"),
      number("fee"),
      number("net"),
      text("type"),
      text("status"),
      epoch("created"),
    ],
  },
  {
    name: "disputes",
    search: false,
    listFilters: ["charge"],
    searchFields: [],
    columns: [number("amount"), text("currency"), text("charge"), text("reason"), text("status"), epoch("created")],
  },
  {
    name: "events",
    search: false,
    listFilters: ["type"],
    searchFields: [],
    columns: [text("type"), epoch("created"), number("pending_webhooks"), text("api_version")],
  },
];

const BY_NAME = new Map(STRIPE_OBJECTS.map((object) => [object.name, object]));

export function stripeObject(name: string): StripeObject {
  const exact = BY_NAME.get(name);
  if (exact !== undefined) return exact;
  const folded = STRIPE_OBJECTS.filter((object) => object.name.toLowerCase() === name.toLowerCase());
  if (folded.length === 1) return folded[0];
  throw new QueryError(`Stripe has no object "${name}".`, PROVIDER);
}

export function stripeColumns(object: StripeObject): readonly StripeColumn[] {
  return [{ name: "id", type: "text" }, ...object.columns];
}

/** List query parameters, or null when the filters have to go to search. */
export function stripeListQuery(object: StripeObject, filters: readonly StripeFilter[]): Record<string, string> | null {
  const params: Record<string, string> = {};
  for (const filter of filters) {
    if (filter.column === "created" && filter.op !== "EQ" && filter.op !== "NEQ") {
      if (typeof filter.value !== "number" || !Number.isInteger(filter.value)) {
        throw new QueryError("Write created as a Unix time in seconds.", PROVIDER);
      }
      const key = { GT: "created[gt]", GTE: "created[gte]", LT: "created[lt]", LTE: "created[lte]" }[filter.op];
      params[key] = String(filter.value);
      continue;
    }
    if (filter.op !== "EQ" || !object.listFilters.includes(filter.column)) return null;
    params[filter.column] =
      typeof filter.value === "boolean" ? (filter.value ? "true" : "false") : String(filter.value);
  }
  return params;
}

/** The search query language for one object's filters. An empty filter list matches objects created after the epoch. */
export function stripeSearchQuery(object: StripeObject, filters: readonly StripeFilter[]): string {
  if (!object.search) {
    throw new QueryError(
      `Stripe cannot search ${object.name}. Filter ${object.listFilters.join(", ") || "nothing"} with =, or created with <, <=, >, >=.`,
      PROVIDER,
    );
  }
  if (filters.length === 0) return "created>0";
  return filters.map((filter) => searchAtom(object, filter)).join(" AND ");
}

function searchAtom(object: StripeObject, filter: StripeFilter): string {
  if (filter.column === "created" && (filter.op === "EQ" || filter.op === "NEQ")) {
    throw new QueryError("Filter created with <, <=, >, or >=. Stripe stores it as Unix seconds.", PROVIDER);
  }
  if (filter.column === "created" && typeof filter.value === "number" && !Number.isInteger(filter.value)) {
    throw new QueryError("Write created as a Unix time in seconds.", PROVIDER);
  }
  if (filter.column !== "created" && !object.searchFields.includes(filter.column)) {
    throw new QueryError(
      `Stripe cannot filter ${object.name}.${filter.column}. Searchable fields: ${["created", ...object.searchFields].join(", ")}.`,
      PROVIDER,
    );
  }
  if (typeof filter.value === "number") {
    const op = { EQ: "=", NEQ: "=", GT: ">", GTE: ">=", LT: "<", LTE: "<=" }[filter.op];
    const atom = `${filter.column}${op}${filter.value}`;
    return filter.op === "NEQ" ? `-${atom}` : atom;
  }
  if (filter.op !== "EQ" && filter.op !== "NEQ") {
    throw new QueryError("Compare a number when using <, <=, >, or >=.", PROVIDER);
  }
  const quoted = `'${String(filter.value).replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
  const atom = `${filter.column}:${quoted}`;
  return filter.op === "NEQ" ? `-${atom}` : atom;
}
