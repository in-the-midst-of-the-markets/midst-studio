import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as realAuth from "@/lib/auth";

const mockGetSession = mock(
  async (): Promise<{ role: string; username: string } | null> => ({
    role: "user",
    username: "ada",
  }),
);

mock.module("@/lib/auth", () => ({
  ...realAuth,
  getSession: mockGetSession,
  readSession: mock(async () => {
    const session = await mockGetSession();
    return session ? { kind: "authenticated", session } : { kind: "anonymous" };
  }),
}));

const { GET } = await import("@/app/api/marketplace/offerings/route");

const originalCatalog = process.env.MARKETPLACE_OFFERINGS;

const OFFERING = {
  id: "acme-trades",
  name: "Acme Trades",
  description: "Tick history",
  priceId: "price_abc",
  priceLabel: "$49/month",
};

beforeEach(() => {
  mockGetSession.mockResolvedValue({ role: "user", username: "ada" });
  delete process.env.MARKETPLACE_OFFERINGS;
});

afterEach(() => {
  if (originalCatalog === undefined) delete process.env.MARKETPLACE_OFFERINGS;
  else process.env.MARKETPLACE_OFFERINGS = originalCatalog;
});

describe("GET /api/marketplace/offerings", () => {
  test("answers 401 and lists nothing without a session", async () => {
    process.env.MARKETPLACE_OFFERINGS = JSON.stringify([OFFERING]);
    mockGetSession.mockResolvedValue(null);

    const response = await GET();

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Authentication required", code: "AUTH_REQUIRED" });
  });

  test("an unset catalog is an empty shop", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ offerings: [] });
  });

  test("returns the catalog without the Stripe price id", async () => {
    process.env.MARKETPLACE_OFFERINGS = JSON.stringify([OFFERING]);

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      offerings: [
        {
          id: "acme-trades",
          name: "Acme Trades",
          description: "Tick history",
          priceLabel: "$5/month",
        },
      ],
    });
  });

  test("a catalog that does not parse is a configuration error", async () => {
    process.env.MARKETPLACE_OFFERINGS = "{";

    const response = await GET();

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "The marketplace catalog is not valid" });
  });
});
