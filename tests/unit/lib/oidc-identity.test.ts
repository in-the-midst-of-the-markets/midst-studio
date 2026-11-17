import { describe, expect, test } from "bun:test";
import { comparableIssuer, emailDomainOf, isEmailDomainAllowed, oidcUsername } from "@/lib/oidc-identity";

describe("comparableIssuer", () => {
  test("drops one trailing slash and normalizes the host, and is null for a value that is not a URL", () => {
    expect(comparableIssuer("https://IdP.example.test/")).toBe("https://idp.example.test");
    expect(comparableIssuer("https://idp.example.test/realms/libredb")).toBe("https://idp.example.test/realms/libredb");
    expect(comparableIssuer("not a url")).toBeNull();
  });
});

// `username` keys a person's saved work, rate limit and audit lines, so it is taken only from a claim the provider
// stands behind: an email it did not mark unverified, else a username that cannot pass for someone else's email.
describe("oidcUsername", () => {
  test("takes the email when the provider marks it verified or says nothing about it", () => {
    expect(oidcUsername({ email: "ada@example.test", email_verified: true, preferred_username: "ada" })).toBe(
      "ada@example.test",
    );
    expect(oidcUsername({ email: "ada@example.test", preferred_username: "ada" })).toBe("ada@example.test");
  });

  test("passes over an email the provider marks unverified", () => {
    expect(oidcUsername({ email: "bob@example.test", email_verified: false, preferred_username: "mallory" })).toBe(
      "mallory",
    );
    expect(oidcUsername({ email: "bob@example.test", email_verified: false })).toBeNull();
  });

  test('reads email_verified sent as a string, as some providers do, so "false" is not taken for verified', () => {
    for (const unverified of ["false", "FALSE", " False "]) {
      expect(
        oidcUsername({ email: "bob@example.test", email_verified: unverified, preferred_username: "mallory" }),
      ).toBe("mallory");
    }
    expect(oidcUsername({ email: "ada@example.test", email_verified: "true", preferred_username: "ada" })).toBe(
      "ada@example.test",
    );
  });

  test("never takes an email-shaped preferred_username, which a user may be free to choose", () => {
    expect(oidcUsername({ preferred_username: "bob@example.test" })).toBeNull();
    expect(
      oidcUsername({ email: "bob@example.test", email_verified: false, preferred_username: "bob@example.test" }),
    ).toBeNull();
  });

  test("ignores empty and non-string values", () => {
    expect(oidcUsername({ email: "", preferred_username: "ada" })).toBe("ada");
    expect(oidcUsername({ email: 42, preferred_username: ["ada"] })).toBeNull();
    expect(oidcUsername({})).toBeNull();
  });
});

describe("isEmailDomainAllowed", () => {
  const allowed = ["example.com", "example.org"];

  test("an empty list admits every account", () => {
    expect(isEmailDomainAllowed({}, [], "https://idp.example.test")).toBe(true);
  });

  test("reads Google's hd claim, and ignores the email, when the issuer is Google", () => {
    const claims = { hd: " Example.COM ", email: "ada@elsewhere.test", email_verified: true };
    expect(isEmailDomainAllowed(claims, allowed, "https://accounts.google.com")).toBe(true);
    expect(isEmailDomainAllowed(claims, allowed, "https://Accounts.Google.com/")).toBe(true);
    expect(emailDomainOf({ email: "ada@example.com", email_verified: true }, "https://accounts.google.com")).toBeNull();
    expect(isEmailDomainAllowed({ hd: "elsewhere.test" }, allowed, "https://accounts.google.com")).toBe(false);
  });

  test("reads the domain of an email the provider marks verified", () => {
    expect(emailDomainOf({ email: "Ada@Example.COM", email_verified: true }, "https://idp.example.test")).toBe(
      "example.com",
    );
    expect(
      isEmailDomainAllowed({ email: "ada@example.org", email_verified: "true" }, allowed, "https://idp.example.test"),
    ).toBe(true);
    expect(isEmailDomainAllowed({ email: "ada@elsewhere.test", email_verified: true }, allowed, "https://idp")).toBe(
      false,
    );
  });

  test("trusts no domain when the email is unverified, empty, or has none", () => {
    expect(emailDomainOf({ email: "ada@example.com", email_verified: false }, "https://idp.example.test")).toBeNull();
    expect(emailDomainOf({ email: "ada@example.com", email_verified: "false" }, "https://idp.example.test")).toBeNull();
    expect(emailDomainOf({ email: "ada@example.com" }, "https://idp.example.test")).toBeNull();
    expect(emailDomainOf({ email: "ada", email_verified: true }, "https://idp.example.test")).toBeNull();
    expect(emailDomainOf({ email: "ada@", email_verified: true }, "https://idp.example.test")).toBeNull();
    expect(emailDomainOf({ email: "", hd: "example.com" }, "https://idp.example.test")).toBeNull();
    expect(isEmailDomainAllowed({ email: "ada@example.com" }, allowed, "https://idp.example.test")).toBe(false);
  });
});
