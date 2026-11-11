/**
 * The SQL subset a PayPal connection runs.
 *
 * PayPal is a REST API, not a SQL server. The editor still speaks SQL, and this module
 * turns one SELECT into one list. Filters, order and the page are applied to that
 * answer. A write, a join and a second statement fail here, before a request.
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

/** The largest page this connection asks for. A shorter PayPal list stays one page. */
export const PAYPAL_ROW_CAP = 500;

const PROVIDER = "paypal" as const;

export type PayPalColumn = ListedColumn;
export type PayPalResource = ListedResource;
export type PayPalSelect = ListedSelect;

interface PayPalList {
  readonly listKey: string;
  readonly query: Readonly<Record<string, string>>;
  /** Transactions need a date window. The provider adds it. The other lists do not. */
  readonly dated: boolean;
}

function column(name: string, type: ListedColumn["type"], json: string): PayPalColumn {
  return { name, type, json };
}

function resource(name: string, primary: string, path: string, columns: readonly PayPalColumn[]): PayPalResource {
  return { name, primary, path, columns };
}

/** The lists the object tree shows. Each one is one PayPal list. */
export const PAYPAL_RESOURCES: readonly PayPalResource[] = Object.freeze([
  resource("transaction", "transaction.id", "/v1/reporting/transactions", [
    column("transaction.id", "text", "transaction_id"),
    column("transaction.event_code", "text", "event_code"),
    column("transaction.status", "text", "status"),
    column("transaction.subject", "text", "subject"),
    column("transaction.initiation_date", "text", "initiation_date"),
    column("transaction.updated_date", "text", "updated_date"),
    column("transaction.amount", "number", "amount"),
    column("transaction.currency", "text", "currency"),
    column("transaction.fee", "number", "fee"),
    column("transaction.invoice_id", "text", "invoice_id"),
    column("transaction.payer_email", "text", "payer_email"),
  ]),
  resource("balance", "balance.currency", "/v1/reporting/balances", [
    column("balance.currency", "text", "currency"),
    column("balance.primary", "text", "primary"),
    column("balance.total", "number", "total"),
    column("balance.available", "number", "available"),
    column("balance.withheld", "number", "withheld"),
  ]),
  resource("invoice", "invoice.id", "/v2/invoicing/invoices", [
    column("invoice.id", "text", "id"),
    column("invoice.status", "text", "status"),
    column("invoice.number", "text", "number"),
    column("invoice.date", "text", "date"),
    column("invoice.currency", "text", "currency"),
    column("invoice.amount", "number", "amount"),
    column("invoice.due", "number", "due"),
  ]),
  resource("dispute", "dispute.id", "/v1/customer/disputes", [
    column("dispute.id", "text", "id"),
    column("dispute.status", "text", "status"),
    column("dispute.reason", "text", "reason"),
    column("dispute.state", "text", "state"),
    column("dispute.created", "text", "created"),
    column("dispute.updated", "text", "updated"),
    column("dispute.amount", "number", "amount"),
    column("dispute.currency", "text", "currency"),
  ]),
  resource("product", "product.id", "/v1/catalogs/products", [
    column("product.id", "text", "id"),
    column("product.name", "text", "name"),
    column("product.type", "text", "type"),
    column("product.category", "text", "category"),
    column("product.created", "text", "created"),
  ]),
  resource("plan", "plan.id", "/v1/billing/plans", [
    column("plan.id", "text", "id"),
    column("plan.name", "text", "name"),
    column("plan.status", "text", "status"),
    column("plan.product_id", "text", "product_id"),
    column("plan.created", "text", "created"),
  ]),
  resource("payout", "payout.id", "/v1/payments/payouts", [
    column("payout.id", "text", "id"),
    column("payout.status", "text", "status"),
    column("payout.created", "text", "created"),
    column("payout.amount", "number", "amount"),
    column("payout.currency", "text", "currency"),
    column("payout.fee", "number", "fee"),
  ]),
]);

const LISTS: Readonly<Record<string, PayPalList>> = Object.freeze({
  transaction: {
    listKey: "transaction_details",
    dated: true,
    query: { page_size: "500", page: "1", fields: "transaction_info,payer_info" },
  },
  balance: { listKey: "balances", dated: false, query: {} },
  invoice: { listKey: "items", dated: false, query: { page_size: "100", page: "1", total_required: "false" } },
  dispute: { listKey: "items", dated: false, query: { page_size: "50" } },
  product: { listKey: "products", dated: false, query: { page_size: "20", page: "1", total_required: "false" } },
  plan: { listKey: "plans", dated: false, query: { page_size: "20", page: "1", total_required: "false" } },
  payout: { listKey: "items", dated: false, query: { page_size: "500", page: "1", total_required: "false" } },
});

const PAYPAL: ListedProduct = {
  provider: PROVIDER,
  rowCap: PAYPAL_ROW_CAP,
  resources: PAYPAL_RESOURCES,
  product: "PayPal",
  example: "transaction",
  exampleColumn: "transaction.id",
};

export function paypalResource(name: string): PayPalResource | undefined {
  return listedResource(PAYPAL, name);
}

/** The query string for one list. Transactions also receive the date window the caller built. */
export function paypalQuery(name: string, dates?: { readonly start: string; readonly end: string }): URLSearchParams {
  const list = LISTS[name];
  const params = new URLSearchParams();
  if (list === undefined) return params;
  if (list.dated && dates !== undefined) {
    params.set("start_date", dates.start);
    params.set("end_date", dates.end);
  }
  for (const [key, value] of Object.entries(list.query)) params.set(key, value);
  return params;
}

/** One statement, or a refusal that names what to write instead. */
export function translatePayPalSql(sql: string): PayPalSelect {
  return translateListedSql(sql, PAYPAL);
}

/** The page of rows one PayPal list becomes, after the provider has flattened it. */
export function paypalRows(
  statement: PayPalSelect,
  entries: readonly unknown[],
  sql: string,
): Record<string, unknown>[] {
  return listedRows(PAYPAL, statement, entries, sql);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function money(value: unknown): { amount: unknown; currency: unknown } {
  if (!isRecord(value)) return { amount: null, currency: null };
  return { amount: value.value ?? null, currency: value.currency_code ?? value.currency ?? null };
}

function text(value: unknown): unknown {
  if (typeof value === "boolean") return value ? "true" : "false";
  return value ?? null;
}

function flatten(name: string, entry: unknown): unknown {
  if (!isRecord(entry)) return entry;
  if (name === "transaction") {
    const info = isRecord(entry.transaction_info) ? entry.transaction_info : {};
    const payer = isRecord(entry.payer_info) ? entry.payer_info : {};
    const amount = money(info.transaction_amount);
    const fee = money(info.fee_amount);
    return {
      transaction_id: info.transaction_id ?? null,
      event_code: info.transaction_event_code ?? null,
      status: info.transaction_status ?? null,
      subject: info.transaction_subject ?? null,
      initiation_date: info.transaction_initiation_date ?? null,
      updated_date: info.transaction_updated_date ?? null,
      amount: amount.amount,
      currency: amount.currency,
      fee: fee.amount,
      invoice_id: info.invoice_id ?? null,
      payer_email: payer.email_address ?? null,
    };
  }
  if (name === "balance") {
    const total = money(entry.total_balance);
    const available = money(entry.available_balance);
    const withheld = money(entry.withheld_balance);
    return {
      currency: entry.currency ?? null,
      primary: text(entry.primary),
      total: total.amount,
      available: available.amount,
      withheld: withheld.amount,
    };
  }
  if (name === "invoice") {
    const detail = isRecord(entry.detail) ? entry.detail : {};
    const amount = money(entry.amount);
    const due = money(entry.due_amount);
    return {
      id: entry.id ?? null,
      status: entry.status ?? null,
      number: detail.invoice_number ?? null,
      date: detail.invoice_date ?? null,
      currency: detail.currency_code ?? amount.currency,
      amount: amount.amount,
      due: due.amount,
    };
  }
  if (name === "dispute") {
    const amount = money(entry.dispute_amount);
    return {
      id: entry.dispute_id ?? null,
      status: entry.status ?? null,
      reason: entry.reason ?? null,
      state: entry.dispute_state ?? null,
      created: entry.create_time ?? null,
      updated: entry.update_time ?? null,
      amount: amount.amount,
      currency: amount.currency,
    };
  }
  if (name === "product") {
    return {
      id: entry.id ?? null,
      name: entry.name ?? null,
      type: entry.type ?? null,
      category: entry.category ?? null,
      created: entry.create_time ?? null,
    };
  }
  if (name === "plan") {
    return {
      id: entry.id ?? null,
      name: entry.name ?? null,
      status: entry.status ?? null,
      product_id: entry.product_id ?? null,
      created: entry.create_time ?? null,
    };
  }
  return {
    id: entry.payout_batch_id ?? null,
    status: entry.batch_status ?? null,
    created: entry.time_created ?? null,
    amount: money(entry.amount).amount,
    currency: money(entry.amount).currency,
    fee: money(entry.fees).amount,
  };
}

/** The flattened rows of one PayPal answer, or a refusal when the body is not that list. */
export function paypalEntries(name: string, body: unknown): unknown[] {
  const list = LISTS[name];
  if (list === undefined || !isRecord(body)) throw new QueryError("PayPal's answer was not a list.", PROVIDER);
  const entries = body[list.listKey];
  if (entries === undefined || entries === null) return [];
  if (!Array.isArray(entries)) throw new QueryError("PayPal's answer was not a list.", PROVIDER);
  return entries.map((entry) => flatten(name, entry));
}

/** Whether PayPal said this page is not the whole list. The next page is not requested. */
export function paypalHasMore(body: unknown): boolean {
  if (!isRecord(body)) return false;
  const pages = body.total_pages;
  if (typeof pages === "number" && pages > 1) return true;
  if (typeof pages === "string" && /^\d+$/.test(pages) && Number(pages) > 1) return true;
  if (!Array.isArray(body.links)) return false;
  return body.links.some((link) => isRecord(link) && link.rel === "next");
}
