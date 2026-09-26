import { expect, test, type Page } from "@playwright/test";
import { mockAppShell } from "./helpers/app-shell-mock";

async function gotoWithRetry(page: Page, path: string) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await page.goto(path, { waitUntil: "commit", timeout: 60000 });
      return;
    } catch (error) {
      if (attempt === 1) {
        throw error;
      }
      await page.waitForTimeout(1000);
    }
  }
}

test.describe("Core user flows", () => {
  test("shows the dashboard connect entry point", async ({ page }) => {
    await mockAppShell(page);

    await gotoWithRetry(page, "/app");

    await expect(page.getByRole("heading", { name: "Save together. Win together." })).toBeVisible({
      timeout: 15000,
    });
    await expect(
      page.getByText("Connect your wallet to deposit, or follow the steps above to get started."),
    ).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole("button", { name: "Connect wallet" })).toBeVisible({
      timeout: 15000,
    });
  });

  test("opens the vault detail page", async ({ page }) => {
    await mockAppShell(page);

    await gotoWithRetry(page, "/app/vaults");

    await expect(page.getByRole("heading", { name: "Vaults" })).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole("heading", { name: "Quick Deposit Flow" })).toBeVisible({
      timeout: 15000,
    });
    await expect(page.getByRole("button", { name: "Open deposit modal" })).toBeVisible({
      timeout: 15000,
    });
  });

  test("reviews wallet status on the account page", async ({ page }) => {
    await mockAppShell(page);

    await gotoWithRetry(page, "/app/account");

    await expect(page.getByRole("heading", { name: "Your profile" })).toBeVisible({
      timeout: 15000,
    });
    await expect(page.getByRole("heading", { name: "Wallet not connected" })).toBeVisible({
      timeout: 15000,
    });
    await expect(page.getByRole("button", { name: "Connect wallet" })).toBeVisible({
      timeout: 15000,
    });
  });

  test("shows the admin settings overview", async ({ page }) => {
    await mockAppShell(page);

    await gotoWithRetry(page, "/app/admin/settings");

    await expect(page.getByRole("heading", { name: "Settings Overview" })).toBeVisible({
      timeout: 15000,
    });
    await expect(page.getByRole("heading", { name: "Protocol parameters" })).toBeVisible({
      timeout: 15000,
    });
    await expect(page.getByRole("heading", { name: "Active rounds" })).toBeVisible({
      timeout: 15000,
    });
    await expect(page.getByRole("heading", { name: "Service status" })).toBeVisible({
      timeout: 15000,
    });
    await expect(page.getByRole("heading", { name: "Operational notes" })).toBeVisible({
      timeout: 15000,
    });
  });

  test("landing page renders", async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });

    await expect(page.getByText("VaultQuest")).toBeVisible();
    await expect(page.getByText("Launch DApp")).toBeVisible();
  });
});
