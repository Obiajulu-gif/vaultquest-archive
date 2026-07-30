import { type Page } from "@playwright/test";
import { injectMockWallet } from "./wallet-mock";

export async function mockAppShell(page: Page, { connected = false } = {}) {
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);

    window.localStorage.clear();
    window.sessionStorage.clear();

    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = typeof input === "string" ? { url: input, method: init?.method ?? "GET" } : input;
      const url = request.url;
      const method = (init?.method ?? request.method ?? "GET").toUpperCase();

      if (method === "HEAD") {
        return new Response("", { status: 200, statusText: "OK" });
      }

      if (url.includes("api.avax.network/ext/bc/C/rpc") && method === "POST") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: "0x5d21dba00",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }

      if (url.includes("horizon.stellar.org/fee_stats")) {
        return new Response(
          JSON.stringify({
            last_ledger_base_fee: 100,
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }

      if (url.includes("/api/health")) {
        return new Response("", { status: 200, statusText: "OK" });
      }

      return originalFetch(input, init);
    };
  });

  if (connected) {
    await injectMockWallet(page, "0x1234567890123456789012345678901234567890");
  } else {
    await page.addInitScript(() => {
      Object.defineProperty(window, "ethereum", {
        configurable: true,
        value: undefined,
      });
    });
  }
}
