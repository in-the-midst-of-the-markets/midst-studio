import "../../setup-dom";
import "../../helpers/mock-navigation";

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { mockGlobalFetch, restoreGlobalFetch } from "../../helpers/mock-fetch";
import CreatePage from "@/app/create/page";

describe("/create", () => {
  afterEach(() => {
    cleanup();
    restoreGlobalFetch();
    localStorage.clear();
  });

  test("offers the IDE and AI, and opens an empty dashboard studio", async () => {
    mockGlobalFetch({
      "/api/storage/config": { json: { provider: "local", serverMode: false } },
    });
    render(<CreatePage />);
    await screen.findByRole("link", { name: "AI" });
    const links = screen.getAllByRole("link").map((link) => ({
      name: link.textContent,
      href: link.getAttribute("href"),
    }));
    expect(links).toEqual([
      { name: "AI", href: "/assist" },
      { name: "IDE", href: "/" },
      { name: "Models", href: "/models" },
    ]);
    expect(await screen.findByRole("heading", { name: "Create" })).toBeTruthy();
    expect(screen.getByText("You have no dashboards yet.")).toBeTruthy();
  });
});
