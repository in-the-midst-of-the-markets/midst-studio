import { describe, expect, test } from "bun:test";
import { DatabaseConfigError } from "@/lib/db/errors";
import {
  REST_CATALOG_LIMIT,
  readRestCatalog,
  restBasicUser,
  restCatalogIssue,
  restHost,
  restHostIssue,
  restSecret,
} from "@/lib/db/providers/sql/rest/catalog";

const resource = { name: "items", path: "/v1/items", rows: "data.items" };

describe("custom API host", () => {
  test("accepts a public hostname and a pasted https URL", () => {
    expect(restHostIssue("api.example.com")).toBeNull();
    expect(restHost(" HTTPS://API.Example.com/ ")).toBe("api.example.com");
  });

  test("refuses a scheme, an address, or a private name", () => {
    expect(restHostIssue("")).toBe("Add the API hostname.");
    expect(restHostIssue("   ")).toBe("Add the API hostname.");
    expect(restHostIssue("http://api.example.com")).toBe("Use HTTPS. The secret is not sent over plain HTTP.");
    expect(restHostIssue("10.1.2.3")).toBe("Use the API's hostname. An IP address is not accepted.");
    expect(restHostIssue("[::1]")).toBe("Use the API's hostname. An IP address is not accepted.");
    expect(restHostIssue("api.example.com/v1")).toBe("Use the hostname on its own, such as api.example.com.");
    expect(restHostIssue("api.example.com?x=1")).toBe("Use the hostname on its own, such as api.example.com.");
    expect(restHostIssue("user@api.example.com")).toBe("Use the hostname on its own, such as api.example.com.");
    expect(restHostIssue("api .example.com")).toBe("Use the hostname on its own, such as api.example.com.");
    expect(restHostIssue("api.example.com%00")).toBe("Use the hostname on its own, such as api.example.com.");
    expect(restHostIssue("localhost")).toBe("That name is not a public API host.");
    expect(restHostIssue("db.localhost")).toBe("That name is not a public API host.");
    expect(restHostIssue("printer.local")).toBe("That name is not a public API host.");
    expect(restHostIssue("metadata.google.internal")).toBe("That name is not a public API host.");
    expect(restHostIssue("box.localdomain")).toBe("That name is not a public API host.");
    expect(restHostIssue("api")).toBe("Use the API's hostname, such as api.example.com.");
    expect(restHostIssue("-api.example.com")).toBe("Use the API's hostname, such as api.example.com.");
    expect(() => restHost("http://api.example.com")).toThrow(DatabaseConfigError);
  });
});

describe("custom API catalog", () => {
  test("reads bearer, header, and basic catalogs", () => {
    const bearer = readRestCatalog(JSON.stringify({ auth: "bearer", resources: [resource] }));
    expect(bearer.headerName).toBe("X-API-Key");
    expect(bearer.resources[0]).toEqual(resource);
    const header = readRestCatalog(
      JSON.stringify({ auth: "header", headerName: " X-API-Key ", resources: [{ ...resource, rows: "" }] }),
    );
    expect(header).toMatchObject({ auth: "header", headerName: "X-API-Key" });
    const basic = readRestCatalog(JSON.stringify({ auth: "basic", resources: [resource] }));
    expect(basic.auth).toBe("basic");
    expect(restCatalogIssue(JSON.stringify({ auth: "bearer", resources: [resource] }))).toBeNull();
  });

  test("refuses a catalog that is not a resource list", () => {
    expect(restCatalogIssue(undefined)).toBe("Add a resource and draw a line from the API to it.");
    expect(restCatalogIssue("  ")).toBe("Add a resource and draw a line from the API to it.");
    expect(restCatalogIssue("x".repeat(REST_CATALOG_LIMIT + 1))).toBe("This API's resource list is too long.");
    expect(restCatalogIssue("{")).toBe("This API's resource list could not be read.");
    expect(restCatalogIssue("[]")).toBe("This API's resource list could not be read.");
    expect(restCatalogIssue(JSON.stringify({ auth: "bearer", resources: "items" }))).toBe(
      "This API's resource list could not be read.",
    );
    expect(restCatalogIssue(JSON.stringify({ auth: "query", resources: [resource] }))).toBe(
      "Choose bearer, a header, or basic authentication.",
    );
    expect(restCatalogIssue(JSON.stringify({ auth: "header", headerName: "", resources: [resource] }))).toBe(
      "Name the header the secret is sent in.",
    );
    expect(
      restCatalogIssue(JSON.stringify({ auth: "header", headerName: "Authorization", resources: [resource] })),
    ).toBe("Name the header the secret is sent in.");
    expect(restCatalogIssue(JSON.stringify({ auth: "bearer", resources: [] }))).toBe(
      "Add a resource and draw a line from the API to it.",
    );
    const many = Array.from({ length: 25 }, (_, index) => ({ name: `item${index}`, path: `/i${index}`, rows: "" }));
    expect(restCatalogIssue(JSON.stringify({ auth: "bearer", resources: many }))).toBe(
      "One API can have at most 24 resources.",
    );
    expect(() => readRestCatalog("{")).toThrow(DatabaseConfigError);
  });

  test("refuses a resource that is not a safe GET path", () => {
    const catalog = (value: unknown) => restCatalogIssue(JSON.stringify({ auth: "bearer", resources: [value] }));
    expect(catalog(null)).toBe("Each resource needs a name, a path, and a rows path.");
    expect(catalog({ name: "1bad", path: "/items", rows: "" })).toBe(
      "Name a resource with letters, digits, and underscores.",
    );
    expect(catalog({ name: "items", path: "items", rows: "" })).toBe("A resource path starts with / and has no query.");
    expect(catalog({ name: "items", path: "/items?x=1", rows: "" })).toBe(
      "A resource path starts with / and has no query.",
    );
    expect(catalog({ name: "items", path: "/items#x", rows: "" })).toBe(
      "A resource path starts with / and has no query.",
    );
    expect(catalog({ name: "items", path: "/items\\x", rows: "" })).toBe(
      "A resource path starts with / and has no query.",
    );
    expect(catalog({ name: "items", path: "/a//b", rows: "" })).toBe("A resource path starts with / and has no query.");
    expect(catalog({ name: "items", path: "/.", rows: "" })).toBe("A resource path starts with / and has no query.");
    expect(catalog({ name: "items", path: "/a/../b", rows: "" })).toBe(
      "A resource path starts with / and has no query.",
    );
    expect(catalog({ name: "items", path: "/a b", rows: "" })).toBe("A resource path starts with / and has no query.");
    expect(catalog({ name: "items", path: "/items", rows: "data items" })).toBe(
      "The rows path names one JSON field, such as data.",
    );
    expect(
      restCatalogIssue(
        JSON.stringify({
          auth: "bearer",
          resources: [resource, { name: "Items", path: "/other", rows: "" }],
        }),
      ),
    ).toBe("Use a different name for each resource.");
  });
});

describe("custom API secret", () => {
  test("keeps a secret and a basic username that can be sent as a header", () => {
    expect(restSecret("super-secret")).toBe("super-secret");
    expect(restBasicUser("account")).toBe("account");
    expect(() => restSecret(undefined)).toThrow(DatabaseConfigError);
    expect(() => restSecret("short")).toThrow(DatabaseConfigError);
    expect(() => restSecret("line\nsecret")).toThrow(DatabaseConfigError);
    expect(() => restBasicUser("")).toThrow(DatabaseConfigError);
    expect(() => restBasicUser("a:b")).toThrow(DatabaseConfigError);
    expect(() => restBasicUser("a\nb")).toThrow(DatabaseConfigError);
  });
});
