import { expect, test, type Page } from "@playwright/test";
import { mockAppShell } from "./helpers/app-shell-mock";

type SmokeRoute = {
  name: string;
  path: string;
  expectedContent: RegExp;
};

const publicRoutes: SmokeRoute[] = [
  {
    name: "marketing landing page",
    path: "/",
    expectedContent: /VaultQuest|Launch DApp/i,
  },
];

const appRoutes: SmokeRoute[] = [
  {
    name: "app dashboard",
    path: "/app",
    expectedContent: /Save together\. Win together\.|Connect your wallet/i,
  },
  {
    name: "prizes index",
    path: "/app/prizes",
    expectedContent: /Prize simulator|Browse active prize rounds/i,
  },
  {
    name: "vaults index",
    path: "/app/vaults",
    expectedContent: /Quick Deposit Flow|Available Pools/i,
  },
  {
    name: "admin settings overview",
    path: "/app/admin/settings",
    expectedContent: /Protocol parameters|Active rounds|Service status/i,
  },
];

const routeLevelCrashPatterns = [
  /Application error/i,
  /Unhandled Runtime Error/i,
  /This page could not be found/i,
];

async function gotoWithRetry(page: Page, path: string) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await page.goto(path, { waitUntil: "commit", timeout: 60000 });
    } catch (error) {
      if (attempt === 1) {
        throw error;
      }
      await page.waitForTimeout(1000);
    }
  }
}

async function expectRouteToRender(page: Page, route: SmokeRoute) {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });

  const response = await gotoWithRetry(page, route.path);

  expect(response, `${route.name} (${route.path}) should return a document response`).not.toBeNull();
  expect(response?.status(), `${route.name} (${route.path}) should return a successful document response`).toBeLessThan(400);

  await expect(page.locator("body"), `${route.name} (${route.path}) should render a non-empty page body`).not.toBeEmpty();
  await expect(page.locator("body"), `${route.name} (${route.path}) should show route-specific content`).toContainText(route.expectedContent);

  for (const pattern of routeLevelCrashPatterns) {
    await expect(page.locator("body"), `${route.name} (${route.path}) should not show ${pattern.toString()}`).not.toContainText(pattern);
  }

  expect(pageErrors, `${route.name} (${route.path}) should not throw route-level runtime errors`).toEqual([]);
}

test.describe("route smoke tests", () => {
  for (const route of publicRoutes) {
    test(`${route.name} renders at ${route.path}`, async ({ page }) => {
      await expectRouteToRender(page, route);
    });
  }

  for (const route of appRoutes) {
    test(`${route.name} renders at ${route.path}`, async ({ page }) => {
      await mockAppShell(page);
      await expectRouteToRender(page, route);
    });
  }
});
