import "../../setup-dom";

import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { setupChartCodeMonacoMock } from "../../helpers/mock-monaco";

const drawn: Record<string, unknown>[] = [];

mock.module("echarts/core", () => ({
  use: () => {},
  init: () => ({
    setOption(option: Record<string, unknown>) {
      drawn.push(option);
    },
    resize() {},
    dispose() {},
  }),
  registerMap: () => {},
}));

mock.module("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

setupChartCodeMonacoMock();

const { SharedDashboard } = await import("@/components/dashboards/SharedDashboard");
const { default: SharePage } = await import("@/app/share/[id]/page");

const ID = "ab".repeat(16);

function shareBody() {
  return {
    name: "Sales",
    refreshedAt: "2026-01-02T00:00:00.000Z",
    dashboard: {
      id: "dash",
      name: "Sales",
      charts: [
        { chartId: "revenue", width: 480, height: 320 },
        { chartId: "empty", width: 200, height: 120 },
        { chartId: "plain", width: 200, height: 120 },
        { chartId: "missing", width: 10, height: 10 },
      ],
      filters: [
        {
          id: "region",
          name: "region",
          label: "Region",
          query: 'SELECT * FROM "f_region"',
          value: "east",
          control: "select",
        },
        {
          id: "total",
          name: "total",
          label: "Total",
          query: "",
          value: "2",
          control: "slider",
          min: 0,
          max: 10,
          step: 1,
        },
        { id: "note", name: "note", query: "", value: "east", control: "search", placeholder: "Find" },
        { id: "picked", name: "picked", query: "", value: "east", choiceSource: "values", valuesText: "east\nwest" },
      ],
      notes: [{ id: "n1", text: "Hello from the note" }],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    charts: [
      {
        id: "revenue",
        token: "c_abc12345",
        name: "Revenue",
        chartType: "bar",
        xAxis: "region",
        yAxis: ["total"],
        query: 'SELECT * FROM "c_abc12345" WHERE region = {{region:east}}',
        typeId: "bar",
        variationId: "basic",
        selection: { category: ["region"], values: ["total"] },
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "empty",
        name: "Empty",
        chartType: "bar",
        xAxis: "region",
        yAxis: ["total"],
        query: "   ",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "plain",
        name: "Plain",
        chartType: "bar",
        xAxis: "region",
        yAxis: ["total"],
        query: 'SELECT * FROM "c_abc12345"',
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  };
}

describe("SharedDashboard", () => {
  afterEach(() => {
    cleanup();
    drawn.length = 0;
  });

  test("draws the snapshot and applies a filter to the copied rows", async () => {
    const queries: string[] = [];
    global.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") {
        const sql = JSON.parse(String(init.body)).sql as string;
        queries.push(sql);
        if (sql.includes("f_region")) {
          return new Response(
            JSON.stringify({ fields: ["region"], rows: [{ region: "east" }, { region: "west" }], rowCount: 2 }),
            { status: 200 },
          );
        }
        if (sql.includes("west")) {
          return new Response(JSON.stringify({ error: "nope" }), { status: 400 });
        }
        return new Response(
          JSON.stringify({ fields: ["region", "total"], rows: [{ region: "east", total: 2 }], rowCount: 1 }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify(shareBody()), { status: 200 });
    }) as unknown as typeof fetch;

    const view = render(<SharedDashboard id={ID} />);
    expect(view.getByText("Loading the dashboard.")).toBeTruthy();
    await waitFor(() => expect(view.getByRole("heading", { name: "Sales" })).toBeTruthy());
    expect(view.getByText("Hello from the note")).toBeTruthy();
    await waitFor(() => expect(view.getByText("This chart has no query in the snapshot.")).toBeTruthy());
    await waitFor(() => expect(view.getByRole("heading", { name: "Revenue" })).toBeTruthy());
    expect(view.getByText("This chart has no shelves.")).toBeTruthy();
    expect(drawn.length).toBeGreaterThan(0);

    fireEvent.change(view.getByLabelText("Region"), { target: { value: "west" } });
    await waitFor(() => expect(view.getByText("nope")).toBeTruthy());
    fireEvent.change(view.getByLabelText("Total"), { target: { value: "4" } });
    fireEvent.change(view.getByLabelText("note"), { target: { value: "north" } });
    expect(queries.some((sql) => sql.includes("f_region"))).toBe(true);
  });

  test("says when the link is gone, and ignores a late answer", async () => {
    let respond: (response: Response) => void = () => undefined;
    global.fetch = mock(
      () =>
        new Promise<Response>((resolve) => {
          respond = resolve;
        }),
    ) as unknown as typeof fetch;
    const view = render(<SharedDashboard id={ID} />);
    view.unmount();
    respond(new Response(JSON.stringify(shareBody()), { status: 200 }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    global.fetch = mock(
      async () => new Response(JSON.stringify({ error: "gone" }), { status: 404 }),
    ) as unknown as typeof fetch;
    const missing = render(<SharedDashboard id={ID} />);
    await waitFor(() => expect(missing.getByText("This shared dashboard is no longer available.")).toBeTruthy());

    global.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") throw new Error("offline");
      return new Response(JSON.stringify(shareBody()), { status: 200 });
    }) as unknown as typeof fetch;
    const unanswered = render(<SharedDashboard id={"ef".repeat(16)} />);
    await waitFor(() => expect(unanswered.getAllByText("The snapshot could not answer.").length).toBeGreaterThan(0));

    global.fetch = mock(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    const other = "cd".repeat(16);
    const failed = render(<SharedDashboard id={other} />);
    await waitFor(() => expect(failed.getByText("This shared dashboard is no longer available.")).toBeTruthy());
  });

  test("the page answers one snapshot and refuses any other id", async () => {
    global.fetch = mock(
      async () => new Response(JSON.stringify(shareBody()), { status: 200 }),
    ) as unknown as typeof fetch;
    const page = await SharePage({ params: Promise.resolve({ id: ID }) });
    const view = render(page);
    expect(view.getByText("Shared")).toBeTruthy();
    await expect(SharePage({ params: Promise.resolve({ id: "nope" }) })).rejects.toThrow("NEXT_NOT_FOUND");
  });
});
