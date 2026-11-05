import "../../setup-dom";
import "../../helpers/mock-navigation";

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import DbtProjectPanel from "@/components/dbt/DbtProjectPanel";
import ModelsPage from "@/app/models/page";
import { holdWorkspaceOwner } from "@/lib/config/base-path";
import { freshDashboard } from "@/lib/dashboards/dashboard";
import { storage } from "@/lib/storage";
import { mockGlobalFetch, restoreGlobalFetch } from "../../helpers/mock-fetch";
import type { DatabaseConnection } from "@/lib/types";

const connection: DatabaseConnection = {
  id: "warehouse",
  name: "Warehouse",
  type: "postgres",
  host: "db.example",
  createdAt: new Date(),
};

const opened = {
  name: "analytics",
  ref: "main",
  profile: { ready: true },
  models: [
    {
      name: "orders",
      path: "models/orders.sql",
      refs: ["stg_orders"],
      sources: [],
      sql: "select * from {{ ref('stg_orders') }}",
      preview: "select * from public.stg_orders",
      unresolved: true,
    },
  ],
  metrics: [
    {
      name: "revenue",
      label: "Revenue",
      sql: "SELECT ordered_at, SUM(amount) AS revenue FROM public.orders",
      reason: null,
      timeDimension: "ordered_at",
    },
    {
      name: "lifetime",
      label: "Lifetime",
      sql: null,
      reason: "Only simple and ratio metrics can be charted.",
      timeDimension: null,
    },
  ],
};

describe("Models", () => {
  afterEach(() => {
    cleanup();
    restoreGlobalFetch();
    localStorage.clear();
    holdWorkspaceOwner(null);
  });

  test("the page offers the IDE", async () => {
    mockGlobalFetch({ "/api/storage/config": { json: { provider: "local", serverMode: false } } });
    render(<ModelsPage />);
    expect(await screen.findByRole("heading", { name: "Models" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "dbt project on GitHub" })).toBeTruthy();
    expect(screen.getByText(/GitHub stores the dbt project/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "IDE" }).getAttribute("href")).toBe("/");
    expect(screen.getByRole("link", { name: "Dash" }).getAttribute("href")).toBe("/create");
  });

  test("saves a model, charts a metric and shows compiled SQL", async () => {
    holdWorkspaceOwner(null);
    storage.saveConnection(connection);
    const dashboard = freshDashboard("Boards", "dash-1");
    storage.saveDashboard(dashboard);
    storage.setActiveDashboardId(dashboard.id);
    mockGlobalFetch({
      "/api/dbt/project": { json: opened },
      "/api/dbt/compile": { json: { ref: "main", files: { "models/orders.sql": "select 1" } } },
    });
    const user = userEvent.setup();
    render(<DbtProjectPanel />);
    await user.type(screen.getByLabelText("GitHub repository"), "acme/analytics");
    await user.selectOptions(screen.getByLabelText("Warehouse connection"), "warehouse");
    await user.click(screen.getByRole("button", { name: "Open dbt project" }));
    expect(await screen.findByRole("heading", { name: /analytics/ })).toBeTruthy();
    expect(screen.getByText(/refs stg_orders/)).toBeTruthy();
    expect(screen.getByText("Compile with dbt to expand the rest of this model.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Save query" }));
    expect(screen.getByRole("link", { name: "Open the IDE" }).getAttribute("href")).toBe("/");
    expect(storage.getSavedQueries()[0]?.query).toContain("public.stg_orders");
    expect(screen.getByText("Only simple and ratio metrics can be charted.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Chart this metric" }));
    expect(screen.getByRole("link", { name: "Open the dashboard" }).getAttribute("href")).toBe("/create");
    const chart = storage.getSavedCharts()[0];
    expect(chart?.metricName).toBe("revenue");
    expect(chart?.chartType).toBe("line");
    expect(chart?.xAxis).toBe("ordered_at");
    expect(storage.getSavedDashboards()[0]?.charts.some((frame) => frame.chartId === chart?.id)).toBe(true);
    expect(storage.getActiveDashboardId()).toBe("dash-1");
    await user.click(screen.getByRole("button", { name: "Compile with dbt" }));
    expect(await screen.findByText(/select 1/)).toBeTruthy();
  });

  test("starts a dashboard when none is open and shows a refusal", async () => {
    holdWorkspaceOwner(null);
    storage.saveConnection(connection);
    const bar = {
      ...opened,
      profile: { ready: false, reason: "Choose a connection to compile with dbt." },
      metrics: [
        {
          name: "total",
          label: "Total",
          sql: "SELECT 'all' AS bucket, COUNT(*) AS total FROM public.orders",
          reason: null,
          timeDimension: null,
        },
      ],
    };
    mockGlobalFetch({
      "/api/dbt/project": async (request) => {
        const body = (await request.json()) as { repo?: string };
        if (body.repo === "missing/repo")
          return { status: 404, json: { error: "This repository could not be read. Check the name and the token." } };
        return { json: bar };
      },
      "/api/dbt/compile": { status: 400, json: { error: "dbt is not installed on this server." } },
    });
    const user = userEvent.setup();
    render(<DbtProjectPanel />);
    await user.type(screen.getByLabelText("GitHub repository"), "acme/analytics");
    await user.click(screen.getByRole("button", { name: "Open dbt project" }));
    expect(await screen.findByText("Choose a connection to compile with dbt.")).toBeTruthy();
    const save = screen.getByRole("button", { name: "Save query" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    save.disabled = false;
    await user.click(save);
    expect(storage.getSavedQueries()).toHaveLength(0);
    expect((screen.getByRole("button", { name: "Chart this metric" }) as HTMLButtonElement).disabled).toBe(true);
    await user.selectOptions(screen.getByLabelText("Warehouse connection"), "warehouse");
    await user.click(screen.getByRole("button", { name: "Chart this metric" }));
    expect(storage.getSavedCharts()[0]?.chartType).toBe("bar");
    expect(storage.getSavedCharts()[0]?.xAxis).toBe("bucket");
    expect(storage.getSavedDashboards()[0]?.name).toBe("Dashboard 1");
    await user.click(screen.getByRole("button", { name: "Compile with dbt" }));
    expect((screen.getByRole("button", { name: "Compile with dbt" }) as HTMLButtonElement).disabled).toBe(true);
    await user.clear(screen.getByLabelText("GitHub repository"));
    await user.type(screen.getByLabelText("GitHub repository"), "missing/repo");
    await user.click(screen.getByRole("button", { name: "Open dbt project" }));
    expect(await screen.findByText("This repository could not be read. Check the name and the token.")).toBeTruthy();
  });

  test("shows a failure when the project request cannot be sent", async () => {
    mockGlobalFetch({
      "/api/dbt/project": () => {
        throw new Error("offline");
      },
    });
    const user = userEvent.setup();
    render(<DbtProjectPanel />);
    await user.type(screen.getByLabelText("GitHub repository"), "acme/analytics");
    await user.click(screen.getByRole("button", { name: "Open dbt project" }));
    expect(await screen.findByText("The project could not be opened.")).toBeTruthy();
  });

  test("shows a failure when the request does not return a project", async () => {
    holdWorkspaceOwner(null);
    storage.saveConnection(connection);
    let openedCalls = 0;
    let compiledCalls = 0;
    mockGlobalFetch({
      "/api/dbt/project": () => {
        openedCalls += 1;
        if (openedCalls === 1) return { status: 500, json: {} };
        return { json: opened };
      },
      "/api/dbt/compile": () => {
        compiledCalls += 1;
        if (compiledCalls === 1) return { status: 400, json: {} };
        throw new Error("offline");
      },
    });
    const user = userEvent.setup();
    render(<DbtProjectPanel />);
    await user.type(screen.getByLabelText("GitHub repository"), "acme/analytics");
    await user.selectOptions(screen.getByLabelText("Warehouse connection"), "warehouse");
    await user.click(screen.getByRole("button", { name: "Open dbt project" }));
    expect(await screen.findByText("The project could not be opened.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Open dbt project" }));
    expect(await screen.findByRole("heading", { name: /analytics/ })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Compile with dbt" }));
    expect(await screen.findByText("dbt compile failed.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Compile with dbt" }));
    expect(await screen.findByText("dbt compile failed.")).toBeTruthy();
  });
});
