import "../../setup-dom";

import { afterEach, describe, expect, mock, test } from "bun:test";
import { useState } from "react";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { DashboardShare } from "@/components/dashboards/DashboardShare";
import type { DatabaseConnection, SavedChartConfig, SavedDashboard } from "@/lib/types";

const ID = "ab".repeat(16);
const calls: { url: string; method: string; body?: string }[] = [];
let handler: (url: string, init?: RequestInit) => Response | Promise<Response> = () =>
  new Response(JSON.stringify({ id: ID, frozen: [{ chart: "Revenue", reason: "kept the current result" }] }), {
    status: 200,
  });

const connection = { id: "c1", type: "postgres", name: "App", createdAt: new Date() } as DatabaseConnection;

function chart(overrides: Partial<SavedChartConfig> = {}): SavedChartConfig {
  return {
    id: "revenue",
    name: "Revenue",
    chartType: "bar",
    xAxis: "region",
    yAxis: ["total"],
    query: "SELECT region, total FROM sales",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    refreshSeconds: 120,
    ...overrides,
  };
}

function board(overrides: Partial<SavedDashboard> = {}): SavedDashboard {
  const now = new Date("2026-01-01T00:00:00.000Z");
  return {
    id: "dash",
    name: "Sales",
    charts: [{ chartId: "revenue", width: 480, height: 320 }],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("DashboardShare", () => {
  const interval = window.setInterval;
  const clear = window.clearInterval;
  let tick: (() => void) | undefined;

  afterEach(() => {
    cleanup();
    calls.length = 0;
    handler = () =>
      new Response(JSON.stringify({ id: ID, frozen: [{ chart: "Revenue", reason: "kept the current result" }] }), {
        status: 200,
      });
    window.setInterval = interval;
    window.clearInterval = clear;
    tick = undefined;
  });

  test("creates a link, copies it, updates the data, and stops sharing", async () => {
    window.setInterval = ((fn: () => void) => {
      tick = fn;
      return 1;
    }) as typeof window.setInterval;
    window.clearInterval = (() => undefined) as typeof window.clearInterval;
    const written: string[] = [];
    Object.assign(navigator, {
      clipboard: {
        writeText: async (value: string) => {
          written.push(value);
        },
      },
    });
    global.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : undefined });
      return handler(url, init);
    }) as unknown as typeof fetch;

    const shared: Array<string | null> = [];
    function Harness() {
      const [shareId, setShareId] = useState<string | undefined>(undefined);
      return (
        <DashboardShare
          dashboard={board(shareId === undefined ? {} : { shareId })}
          charts={[
            chart({ refreshSeconds: undefined }),
            chart({ id: "slower", refreshSeconds: 120 }),
            chart({ id: "other", refreshSeconds: 90 }),
          ]}
          connections={[connection]}
          onShareId={(id) => {
            shared.push(id);
            setShareId(id ?? undefined);
          }}
        />
      );
    }
    const view = render(<Harness />);
    fireEvent.click(view.getByRole("button", { name: "Share" }));
    expect(view.getByRole("dialog", { name: "Share dashboard" })).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Create link" }));
    await waitFor(() => expect(view.getByLabelText("Share link").getAttribute("value")).toContain(`/share/${ID}`));
    expect(shared).toEqual([ID]);
    expect(view.getByText(/kept the current result/)).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(view.getByRole("button", { name: "Copied" })).toBeTruthy());
    expect(written[0]).toContain(`/share/${ID}`);

    fireEvent.click(view.getByRole("button", { name: "Update data" }));
    await waitFor(() => expect(calls.some((call) => call.url.endsWith("/refresh"))).toBe(true));
    tick?.();
    await waitFor(() => expect(calls.filter((call) => call.url.endsWith("/refresh")).length).toBeGreaterThan(1));

    fireEvent.click(view.getByRole("button", { name: "Stop sharing" }));
    await waitFor(() => expect(shared).toContain(null));
    fireEvent.click(view.getByRole("button", { name: "Close" }));
    expect(view.queryByRole("dialog")).toBeNull();
  });

  test("shows the answer when the snapshot cannot be saved", async () => {
    Object.assign(navigator, {
      clipboard: {
        writeText: async () => {
          throw new Error("blocked");
        },
      },
    });
    global.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method ?? "GET" });
      return handler(String(input), init);
    }) as unknown as typeof fetch;
    handler = () => Promise.reject(new Error("offline"));
    const view = render(
      <DashboardShare
        dashboard={board({ shareId: ID })}
        charts={[chart()]}
        connections={[connection]}
        onShareId={() => undefined}
      />,
    );
    fireEvent.click(view.getByRole("button", { name: "Share" }));
    fireEvent.click(view.getByRole("button", { name: "Copy" }));
    fireEvent.click(view.getByRole("button", { name: "Update link" }));
    await waitFor(() => expect(view.getByText("The snapshot could not be saved.")).toBeTruthy());

    handler = () => new Response(JSON.stringify({ error: "busy" }), { status: 400 });
    fireEvent.click(view.getByRole("button", { name: "Update data" }));
    await waitFor(() => expect(view.getByText("busy")).toBeTruthy());

    handler = () => new Response("nope", { status: 500, headers: { "content-type": "text/plain" } });
    fireEvent.click(view.getByRole("button", { name: "Update data" }));
    await waitFor(() => expect(view.getByText("The snapshot could not be saved.")).toBeTruthy());

    handler = () => new Response(JSON.stringify({ error: "" }), { status: 400 });
    fireEvent.click(view.getByRole("button", { name: "Stop sharing" }));
    await waitFor(() => expect(view.getByText("The snapshot could not be saved.")).toBeTruthy());

    handler = () => new Response(JSON.stringify({ error: "no id" }), { status: 400 });
    fireEvent.click(view.getByRole("button", { name: "Update link" }));
    await waitFor(() => expect(view.getByText("no id")).toBeTruthy());

    handler = () => Promise.reject(new Error("offline"));
    fireEvent.click(view.getByRole("button", { name: "Stop sharing" }));
    await waitFor(() => expect(view.getByText("The snapshot could not be saved.")).toBeTruthy());
  });
});
