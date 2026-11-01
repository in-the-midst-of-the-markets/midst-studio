import "../../setup-dom";
import "../../helpers/mock-navigation";

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { mockGlobalFetch, restoreGlobalFetch } from "../../helpers/mock-fetch";
import MarketplacePage from "@/app/marketplace/page";

describe("/marketplace", () => {
  afterEach(() => {
    cleanup();
    restoreGlobalFetch();
  });

  test("links back to the editor and lists the catalog", async () => {
    mockGlobalFetch({
      "/api/storage/config": { json: { provider: "local", serverMode: false } },
      "/api/marketplace/offerings": { json: { offerings: [] } },
    });

    render(<MarketplacePage />);

    const link = await screen.findByRole("link", { name: /Back to the editor/i });
    expect(link.getAttribute("href")).toBe("/");
    expect(await screen.findByRole("heading", { name: "Marketplace" })).not.toBeNull();
    expect(
      screen.getByText("No databases are listed yet. A connection you add in the editor is not listed here."),
    ).not.toBeNull();
  });
});
