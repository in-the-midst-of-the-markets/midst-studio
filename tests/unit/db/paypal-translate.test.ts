import { describe, expect, test } from "bun:test";
import { DatabaseConfigError, QueryError } from "@/lib/db/errors";
import { paypalHost, readPayPalClientId, readPayPalSecret } from "@/lib/db/providers/sql/paypal/auth";
import { PAYPAL_SQL_GRAMMAR } from "@/lib/db/providers/sql/paypal/sql-grammar";
import { PAYPAL_SQL_WRITING } from "@/lib/db/providers/sql/paypal/sql-writing";
import { PAYPAL_CONNECTION_STRING } from "@/lib/db/providers/sql/paypal/connection-string";
import { PAYPAL_EXECUTION_UI } from "@/lib/db/providers/sql/paypal/execution-ui";
import { PAYPAL_MIGRATION_DDL } from "@/lib/db/providers/sql/paypal/migration-ddl";
import {
  PAYPAL_ROW_CAP,
  paypalEntries,
  paypalHasMore,
  paypalQuery,
  paypalRows,
  translatePayPalSql,
} from "@/lib/db/providers/sql/paypal/translate";
import type { DatabaseConnection } from "@/lib/types";

const base = {
  id: "pp",
  name: "pp",
  type: "paypal",
  host: "",
  user: "client-id",
  database: "",
  password: "client-secret",
  createdAt: new Date(0),
} as DatabaseConnection;

describe("PayPal credentials", () => {
  test("accepts the live host, the sandbox host and a pasted URL", () => {
    expect(paypalHost(base)).toBe("api-m.paypal.com");
    expect(paypalHost({ ...base, host: "api-m.sandbox.paypal.com" })).toBe("api-m.sandbox.paypal.com");
    expect(paypalHost({ ...base, host: "https://api-m.paypal.com/v1" })).toBe("api-m.paypal.com");
    expect(readPayPalClientId("  client-id  ")).toBe("client-id");
    expect(readPayPalSecret("client-secret")).toBe("client-secret");
    expect(() => readPayPalClientId(undefined)).toThrow(/client id/);
    expect(() => readPayPalSecret(undefined)).toThrow(/secret/);
    expect(() => readPayPalClientId("")).toThrow(DatabaseConfigError);
    expect(() => readPayPalClientId("short")).toThrow(DatabaseConfigError);
    expect(() => readPayPalClientId("a".repeat(301))).toThrow(DatabaseConfigError);
    expect(() => readPayPalClientId("client id")).toThrow(DatabaseConfigError);
    expect(() => readPayPalClientId("client:id")).toThrow(/colon/);
    expect(() => readPayPalSecret("")).toThrow(DatabaseConfigError);
    expect(() => readPayPalSecret("short")).toThrow(DatabaseConfigError);
    expect(() => readPayPalSecret("a".repeat(301))).toThrow(DatabaseConfigError);
    expect(() => readPayPalSecret("secret\nsecret")).toThrow(DatabaseConfigError);
    expect(() => paypalHost({ ...base, host: "https://evil.example" })).toThrow(DatabaseConfigError);
    expect(() => paypalHost({ ...base, host: "api.paypal.com" })).toThrow(DatabaseConfigError);
    expect(() => paypalHost({ ...base, host: "api-m.paypal.com:8443" })).toThrow(DatabaseConfigError);
    expect(() => paypalHost({ ...base, host: "https://user:secret@api-m.paypal.com" })).toThrow(DatabaseConfigError);
    expect(() => paypalHost({ ...base, host: "paypal.com" })).toThrow(DatabaseConfigError);
  });
});

describe("PayPal SQL", () => {
  test("reads one list, then filters the flattened page", () => {
    expect(PAYPAL_ROW_CAP).toBe(500);
    expect(PAYPAL_SQL_GRAMMAR.readsSqlText).toBe(true);
    const formatSegment = PAYPAL_SQL_GRAMMAR.completion.formatSegment;
    const readQuoted = PAYPAL_SQL_GRAMMAR.completion.readQuotedQualifier;
    if (formatSegment == null || readQuoted == null) throw new Error("PayPal completion is missing a quoter");
    expect(formatSegment('a"b')).toBe('"a""b"');
    expect(readQuoted('"a""b".')).toBe('a"b');
    expect(PAYPAL_SQL_WRITING.placeholder).toBeNull();
    expect(PAYPAL_CONNECTION_STRING.scheme).toBeNull();
    expect(PAYPAL_EXECUTION_UI.consentDeadline).toBeNull();
    expect(PAYPAL_MIGRATION_DDL.tableDdl).toBe("refused");
    const statement = translatePayPalSql(
      "SELECT transaction.id, transaction.amount FROM transaction WHERE transaction.status = 'S' AND transaction.amount > 10 ORDER BY transaction.amount DESC LIMIT 100",
    );
    expect(statement.resource.path).toBe("/v1/reporting/transactions");
    expect(
      paypalQuery("transaction", { start: "2026-01-01T00:00:00Z", end: "2026-01-31T00:00:00Z" }).get("page_size"),
    ).toBe("500");
    expect(paypalQuery("nope").toString()).toBe("");
    const rows = paypalRows(
      statement,
      paypalEntries("transaction", {
        transaction_details: [
          {
            transaction_info: {
              transaction_id: "T1",
              transaction_status: "S",
              transaction_amount: { currency_code: "USD", value: "12.50" },
              fee_amount: { currency_code: "USD", value: "0.50" },
            },
            payer_info: { email_address: "a@example.com" },
          },
          { transaction_info: { transaction_id: "T2", transaction_status: "D", transaction_amount: { value: "3" } } },
        ],
      }),
      "sql",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ "transaction.id": "T1", "transaction.amount": "12.50", "transaction.fee": "0.50" });
    expect(() => paypalRows(statement, paypalEntries("transaction", { transaction_details: ["nope"] }), "sql")).toThrow(
      QueryError,
    );
    expect(paypalEntries("transaction", { transaction_details: [{}] })[0]).toMatchObject({
      transaction_id: null,
      payer_email: null,
    });
    expect(paypalEntries("balance", { balances: null })).toEqual([]);
    expect(paypalEntries("balance", {})).toEqual([]);
    expect(paypalEntries("balance", { balances: [{ currency: "EUR" }] })[0]).toMatchObject({
      currency: "EUR",
      primary: null,
    });
    expect(
      paypalEntries("balance", {
        balances: [
          {
            currency: "USD",
            primary: true,
            total_balance: { value: "9" },
            available_balance: {},
            withheld_balance: "x",
          },
        ],
      })[0],
    ).toMatchObject({ currency: "USD", primary: "true", total: "9", available: null, withheld: null });
    expect(
      paypalEntries("invoice", {
        items: [
          {
            id: "INV",
            status: "PAID",
            detail: { invoice_number: "1", currency_code: "EUR" },
            amount: { currency_code: "USD", value: "4" },
          },
        ],
      })[0],
    ).toMatchObject({ id: "INV", number: "1", amount: "4", due: null, currency: "EUR" });
    expect(paypalEntries("invoice", { items: [{}] })[0]).toMatchObject({ number: null, currency: null });
    expect(
      paypalEntries("dispute", {
        items: [{ dispute_id: "D", dispute_amount: { currency_code: "EUR", value: "2" } }],
      })[0],
    ).toMatchObject({ id: "D", amount: "2", currency: "EUR" });
    expect(paypalEntries("product", { products: [{ id: "P", name: "Hat" }] })[0]).toMatchObject({
      id: "P",
      name: "Hat",
    });
    expect(paypalEntries("plan", { plans: [{ id: "PL", product_id: "P" }] })[0]).toMatchObject({ product_id: "P" });
    expect(
      paypalEntries("payout", {
        items: [
          {
            payout_batch_id: "B",
            batch_status: "SUCCESS",
            amount: { currency: "USD", value: "8" },
            fees: { value: "1" },
          },
        ],
      })[0],
    ).toMatchObject({ id: "B", amount: "8", currency: "USD", fee: "1" });
    expect(() => paypalEntries("missing", {})).toThrow(QueryError);
    expect(() => paypalEntries("product", [])).toThrow(QueryError);
    expect(() => paypalEntries("product", { products: {} })).toThrow(QueryError);
    expect(paypalHasMore({ total_pages: 2 })).toBe(true);
    expect(paypalHasMore({ total_pages: "2" })).toBe(true);
    expect(paypalHasMore({ total_pages: "1" })).toBe(false);
    expect(paypalHasMore({ total_pages: "no" })).toBe(false);
    expect(paypalHasMore({ total_pages: 1, links: [{ rel: "self" }] })).toBe(false);
    expect(paypalHasMore({ links: [{ rel: "next" }] })).toBe(true);
    expect(paypalHasMore({ links: ["nope"] })).toBe(false);
    expect(paypalHasMore({ links: "nope" })).toBe(false);
    expect(paypalHasMore(null)).toBe(false);
    expect(translatePayPalSql("SELECT * FROM balance").resource.path).toBe("/v1/reporting/balances");
    expect(translatePayPalSql("SELECT invoice.id FROM invoice").resource.path).toBe("/v2/invoicing/invoices");
    expect(translatePayPalSql("SELECT dispute.id FROM dispute").resource.path).toBe("/v1/customer/disputes");
    expect(translatePayPalSql("SELECT product.name FROM product").resource.path).toBe("/v1/catalogs/products");
    expect(translatePayPalSql("SELECT plan.name FROM plan").resource.path).toBe("/v1/billing/plans");
    expect(translatePayPalSql("SELECT payout.id FROM payout").resource.path).toBe("/v1/payments/payouts");
    expect(() => translatePayPalSql("DELETE FROM transaction")).toThrow(/read-only/);
    expect(() => translatePayPalSql("")).toThrow(QueryError);
  });
});
