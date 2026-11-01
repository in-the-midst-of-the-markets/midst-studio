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
const originalConnection = process.env.OPEN_SEARCH_CONNECTION_STRING;

const OFFERING = {
  id: "opensearch",
  name: "OpenSearch",
  description: "Search indexes",
  monthlyCents: 500,
};

beforeEach(() => {
  mockGetSession.mockResolvedValue({ role: "user", username: "ada" });
  delete process.env.MARKETPLACE_OFFERINGS;
  delete process.env.OPEN_SEARCH_CONNECTION_STRING;
});

afterEach(() => {
  if (originalCatalog === undefined) delete process.env.MARKETPLACE_OFFERINGS;
  else process.env.MARKETPLACE_OFFERINGS = originalCatalog;
  if (originalConnection === undefined) delete process.env.OPEN_SEARCH_CONNECTION_STRING;
  else process.env.OPEN_SEARCH_CONNECTION_STRING = originalConnection;
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

  test("returns each database's own monthly price", async () => {
    process.env.MARKETPLACE_OFFERINGS = JSON.stringify([
      OFFERING,
      { id: "postgres", name: "PostgreSQL", description: "Tables", monthlyCents: 1200 },
    ]);

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      offerings: [
        { id: "opensearch", name: "OpenSearch", description: "Search indexes", priceLabel: "$5/month" },
        { id: "postgres", name: "PostgreSQL", description: "Tables", priceLabel: "$12/month" },
      ],
    });
  });

  test("a catalog that does not parse is a configuration error", async () => {
    process.env.MARKETPLACE_OFFERINGS = "{";
    process.env.OPEN_SEARCH_CONNECTION_STRING = "https://user:secret-token@search.example:9200";

    const response = await GET();

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "The marketplace catalog is not valid" });
  });

  test("lists OpenSearch from its connection string and does not return the string", async () => {
    const secret = "https://user:secret-token@search.example:9200";
    process.env.OPEN_SEARCH_CONNECTION_STRING = secret;

    const response = await GET();
    const body: unknown = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      offerings: [{ id: "opensearch", name: "OpenSearch", description: "Search indexes", priceLabel: "$5/month" }],
    });
    expect(JSON.stringify(body)).not.toContain("secret-token");
  });
});
