import "../setup-dom";

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MotionGlobalConfig } from "framer-motion";

import { ConnectionModal } from "@/components/ConnectionModal";

// The dialog's banners animate in; happy-dom cancels an animation still running when the test ends.
MotionGlobalConfig.skipAnimations = true;

afterEach(cleanup);

function openDialog(): void {
  render(<ConnectionModal isOpen onClose={() => {}} onConnect={() => {}} />);
}

describe("connection picker categories", () => {
  test("categories start collapsed, including SQL, and a click opens one", () => {
    openDialog();

    const sql = screen.getByRole("button", { name: "SQL" });
    const commerce = screen.getByRole("button", { name: "Commerce" });
    const custom = screen.getByRole("button", { name: "Custom" });
    expect(sql.getAttribute("aria-expanded")).toBe("false");
    expect(commerce.getAttribute("aria-expanded")).toBe("false");
    expect(custom.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: "PostgreSQL" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Supabase" })).toBeNull();
    expect(screen.queryByRole("button", { name: "HubSpot" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Stripe" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Airtable" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Custom API" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Datadog" })).toBeNull();

    fireEvent.click(sql);
    expect(sql.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: "PostgreSQL" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Supabase" })).toBeDefined();

    fireEvent.click(sql);
    expect(sql.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: "PostgreSQL" })).toBeNull();

    fireEvent.click(sql);
    expect(sql.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: "PostgreSQL" })).toBeDefined();

    fireEvent.click(commerce);
    expect(commerce.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: "Odoo" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Shopify" })).toBeDefined();
    expect(screen.queryAllByRole("button", { name: "Custom API" })).toHaveLength(0);

    fireEvent.click(custom);
    expect(screen.getAllByRole("button", { name: "Custom API" })).toHaveLength(1);

    const warehouses = screen.getByRole("button", { name: "Warehouses" });
    fireEvent.click(warehouses);
    const order = screen.getAllByRole("button").map((button) => button.textContent?.replaceAll(/\s+/g, "") ?? "");
    const snowflakeAt = order.indexOf("Snowflake");
    expect(order[snowflakeAt + 1]).toBe("DatabricksSQL");
  });
});
