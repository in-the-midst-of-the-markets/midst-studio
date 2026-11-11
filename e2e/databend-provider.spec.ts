import { expect, type Page, test } from "@playwright/test";
import { DATABEND_FIELD_RULES, DB_UI_CONFIG } from "../src/lib/db-ui-config";

/**
 * What a user sees in the connection dialog when choosing Databend (design 6.1 to 6.3).
 *
 * What a new type-id needs in order to be SELECTABLE lives outside the provider, as declarations (`DatabaseUIConfig`,
 * `selectableTypes`), which is why this runs in a browser. No assertion here reaches a Databend
 * server: the form's field checks refuse before Test Connection sends
 * anything, which each refusal test proves by counting the requests to the test route, so no Databend is needed. It
 * runs on the second server all the same (the chromium-databend project of playwright.config.ts): each test signs in
 * and opens the dialog, which spends the shared account's query budget, and on the shared server three specs after it
 * met that budget's refusal. Every sentence it expects is imported from the module that owns it.
 */
const databend = DB_UI_CONFIG.databend;

async function openDialog(page: Page) {
  await page.goto("/login");
  await page.locator('input[type="email"]').fill("user@libredb.org");
  await page.locator('input[type="password"]').fill("test-user");
  await page.getByRole("button", { name: "Sign In" }).click();
  await page.waitForURL("/");
  await expect(page.locator("text=Query 1").first()).toBeVisible({ timeout: 10000 });

  const sidebarButtons = page.locator("text=KnowSQL").locator("..").locator("..").locator("button");
  await sidebarButtons.last().click();
  const dialog = page.locator('[role="dialog"]');
  await expect(dialog).toBeVisible({ timeout: 5000 });
  return dialog;
}

/** Counts the requests Test Connection would send, so a refusal can be shown to send none. */
function countTestRequests(page: Page): () => number {
  let count = 0;
  page.on("request", (request) => {
    if (request.url().includes("/api/db/test-connection")) count += 1;
  });
  return () => count;
}

test.describe("Databend in the connection dialog", () => {
  test("is offered as its own driver and prefills port 8000", async ({ page }) => {
    const dialog = await openDialog(page);
    await dialog.getByRole("button", { name: databend.label, exact: true }).click();
    await expect(dialog.locator("#port")).toHaveValue(databend.defaultPort);
    await expect(dialog.locator("#port")).toHaveValue("8000");
    await expect(dialog.getByText("Connection String", { exact: true })).toHaveCount(0);
  });

  test("draws Host, Port, User, Password, Database and Warehouse, and the SSL / TLS panel", async ({ page }) => {
    const dialog = await openDialog(page);
    await dialog.getByRole("button", { name: databend.label, exact: true }).click();
    for (const id of ["host", "port", "user", "password", "database", "warehouse"]) {
      // oxlint-disable-next-line no-await-in-loop -- one locator at a time, so a failure names its box.
      await expect(dialog.locator(`#${id}`)).toBeVisible();
    }
    await expect(dialog.locator('label[for="warehouse"]')).toHaveText(databend.fieldLabels?.warehouse ?? "");
    await expect(dialog.getByTestId("warehouse-hint")).toHaveText(databend.fieldHints?.warehouse ?? "");
    await expect(dialog.getByText("SSL / TLS", { exact: true })).toBeVisible();
  });

  test("an empty User is refused naming the field, before anything is sent", async ({ page }) => {
    const sent = countTestRequests(page);
    const dialog = await openDialog(page);
    await dialog.getByRole("button", { name: databend.label, exact: true }).click();
    await dialog.locator("#host").fill("databend.internal");
    await dialog.getByRole("button", { name: "Test Connection", exact: true }).click();
    const result = dialog.getByTestId("connection-test-result");
    await expect(result).toHaveText(DATABEND_FIELD_RULES.user?.required ?? "");
    await expect(result).toContainText("User");
    expect(sent()).toBe(0);
  });

  test("a valid form sends one Test Connection, so the refusal counts below are not vacuous", async ({ page }) => {
    const sent = countTestRequests(page);
    // Answered in the browser, so no server is reached; the counter still sees the request.
    await page.route("**/api/db/test-connection", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true }) }),
    );
    const dialog = await openDialog(page);
    await dialog.getByRole("button", { name: databend.label, exact: true }).click();
    await dialog.locator("#host").fill("databend.internal");
    await dialog.locator("#user").fill("root");
    await dialog.locator("#warehouse").fill("wh-prod");
    await dialog.getByRole("button", { name: "Test Connection", exact: true }).click();
    await expect.poll(sent).toBe(1);
    await expect(dialog.getByTestId("connection-test-result")).not.toContainText("Warehouse");
  });

  test("a Warehouse outside the naming rule is refused naming the field, before anything is sent", async ({ page }) => {
    const sent = countTestRequests(page);
    const dialog = await openDialog(page);
    await dialog.getByRole("button", { name: databend.label, exact: true }).click();
    await dialog.locator("#host").fill("databend.internal");
    await dialog.locator("#user").fill("root");
    await dialog.locator("#warehouse").fill("wh.prod");
    await dialog.getByRole("button", { name: "Test Connection", exact: true }).click();
    const result = dialog.getByTestId("connection-test-result");
    await expect(result).toHaveText(DATABEND_FIELD_RULES.warehouse?.format?.sentence ?? "");
    await expect(result).toContainText("Warehouse");
    await expect(result).not.toContainText("wh.prod");
    expect(sent()).toBe(0);
  });
});
