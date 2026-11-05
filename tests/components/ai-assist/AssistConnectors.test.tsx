import "../../setup-dom";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { AssistConnectors } from "@/components/ai-assist/AssistConnectors";

const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  localStorage.removeItem("libredb_ai_assist");
});

describe("AssistConnectors", () => {
  test("saves a key for each provider and does not show it again", async () => {
    globalThis.fetch = (async () => jsonResponse({ serverKey: true })) as unknown as typeof fetch;
    const view = render(<AssistConnectors onClose={() => {}} />);
    expect(await view.findByText(/this server already has one/)).toBeTruthy();
    const openRouter = view.getByLabelText("OpenRouter API key") as HTMLInputElement;
    expect(openRouter.placeholder).toBe("sk-or-...");
    expect(view.queryByRole("button", { name: "Save OpenRouter API key" })).toBeNull();
    fireEvent.change(openRouter, { target: { value: "ork-secret" } });
    fireEvent.click(view.getByRole("button", { name: "Save OpenRouter API key" }));
    expect(view.getByText("API key saved")).toBeTruthy();
    expect(view.container.textContent?.includes("ork-secret")).toBe(false);
    expect(JSON.parse(localStorage.getItem("libredb_ai_assist") ?? "{}").openRouterKey).toBe("ork-secret");

    fireEvent.click(view.getByRole("button", { name: "Replace OpenRouter API key" }));
    expect((view.getByLabelText("OpenRouter API key") as HTMLInputElement).value).toBe("");
    fireEvent.click(view.getByRole("button", { name: "Save OpenRouter API key" }));
    expect(JSON.parse(localStorage.getItem("libredb_ai_assist") ?? "{}").openRouterKey).toBe("");
    expect(view.queryByText("API key saved")).toBeNull();

    fireEvent.click(view.getByLabelText("Fireworks AI"));
    expect(view.getByText(/A Fireworks model uses the key you save here/)).toBeTruthy();
    fireEvent.change(view.getByLabelText("Fireworks API key"), { target: { value: "fw-secret" } });
    fireEvent.click(view.getByRole("button", { name: "Save Fireworks API key" }));
    expect(view.container.textContent?.includes("fw-secret")).toBe(false);

    fireEvent.click(view.getByLabelText("Vercel AI Gateway"));
    expect(view.getByText(/Vercel AI Gateway uses the key you save here/)).toBeTruthy();
    fireEvent.change(view.getByLabelText("Vercel AI Gateway API key"), { target: { value: "gw-secret" } });
    fireEvent.click(view.getByRole("button", { name: "Save Vercel AI Gateway API key" }));
    expect(view.queryByLabelText("Vercel AI Gateway API key")).toBeNull();
    expect(view.container.textContent?.includes("gw-secret")).toBe(false);
    const stored = JSON.parse(localStorage.getItem("libredb_ai_assist") ?? "{}") as {
      source: string;
      fireworksKey: string;
      gatewayKey: string;
    };
    expect(stored.source).toBe("gateway");
    expect(stored.fireworksKey).toBe("fw-secret");
    expect(stored.gatewayKey).toBe("gw-secret");
  });

  test("closes from the button and the backdrop, and not from the dialog", async () => {
    globalThis.fetch = (async () => jsonResponse({}, 500)) as unknown as typeof fetch;
    let closed = 0;
    const view = render(
      <AssistConnectors
        onClose={() => {
          closed += 1;
        }}
      />,
    );
    fireEvent.click(view.getByRole("dialog", { name: "Connectors" }));
    expect(closed).toBe(0);
    fireEvent.click(view.getByRole("button", { name: "Dismiss connectors" }));
    expect(closed).toBe(1);
    fireEvent.click(view.getByRole("button", { name: "Close" }));
    expect(closed).toBe(2);
    await Promise.resolve();
  });

  test("reads whether the server already has a key", async () => {
    globalThis.fetch = (async () => jsonResponse(null)) as unknown as typeof fetch;
    const blank = render(<AssistConnectors onClose={() => {}} />);
    expect(await blank.findByText(/Leave the OpenRouter key blank/)).toBeTruthy();
    blank.unmount();

    globalThis.fetch = (async () => jsonResponse("nope")) as unknown as typeof fetch;
    const text = render(<AssistConnectors onClose={() => {}} />);
    expect(await text.findByText(/Leave the OpenRouter key blank/)).toBeTruthy();
    text.unmount();

    globalThis.fetch = (async () => jsonResponse({ serverKey: false })) as unknown as typeof fetch;
    const absent = render(<AssistConnectors onClose={() => {}} />);
    expect(await absent.findByText(/Leave the OpenRouter key blank/)).toBeTruthy();
    absent.unmount();

    globalThis.fetch = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    const failed = render(<AssistConnectors onClose={() => {}} />);
    expect(await failed.findByText(/Leave the OpenRouter key blank/)).toBeTruthy();
  });

  test("ignores a catalog that arrives after the dialog is gone", async () => {
    let release: ((response: Response) => void) | undefined;
    globalThis.fetch = (() =>
      new Promise<Response>((resolve) => {
        release = resolve;
      })) as unknown as typeof fetch;
    const view = render(<AssistConnectors onClose={() => {}} />);
    await waitFor(() => expect(release).toBeTypeOf("function"));
    view.unmount();
    release?.(jsonResponse({ serverKey: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    let rejectFetch: ((reason: unknown) => void) | undefined;
    globalThis.fetch = (() =>
      new Promise<Response>((_resolve, reject) => {
        rejectFetch = reject;
      })) as unknown as typeof fetch;
    const failing = render(<AssistConnectors onClose={() => {}} />);
    await waitFor(() => expect(rejectFetch).toBeTypeOf("function"));
    failing.unmount();
    rejectFetch?.(new Error("gone"));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
