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
  test("a click on Databases or SAAS hides that category, and the next click shows it", () => {
    openDialog();

    const databases = screen.getByRole("button", { name: "Databases" });
    const saas = screen.getByRole("button", { name: "SAAS" });
    expect(databases.getAttribute("aria-expanded")).toBe("true");
    expect(saas.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: "PostgreSQL" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Airtable" })).toBeDefined();
    expect(screen.getByRole("button", { name: "HubSpot" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Stripe" })).toBeDefined();

    fireEvent.click(databases);
    expect(databases.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: "PostgreSQL" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Airtable" })).toBeNull();
    expect(screen.getByRole("button", { name: "HubSpot" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Stripe" })).toBeDefined();

    fireEvent.click(databases);
    expect(databases.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: "PostgreSQL" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Airtable" })).toBeDefined();

    fireEvent.click(saas);
    expect(saas.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: "HubSpot" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Stripe" })).toBeNull();
    expect(screen.getByRole("button", { name: "PostgreSQL" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Supabase" })).toBeDefined();

    fireEvent.click(saas);
    expect(saas.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: "HubSpot" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Stripe" })).toBeDefined();
  });
});
