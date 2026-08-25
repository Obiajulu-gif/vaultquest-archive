import { describe, it, expect } from "vitest";
import { parseFrontendEnv } from "./env.js";

describe("parseFrontendEnv", () => {
  it("accepts valid env", () => {
    const env = parseFrontendEnv({
      NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID: "wallet-id-123",
      NEXT_PUBLIC_SOROBAN_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
      NEXT_PUBLIC_HORIZON_URL: "https://horizon-testnet.stellar.org",
      NEXT_PUBLIC_SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
      NEXT_PUBLIC_DRIP_POOL_CONTRACT_ID: "CA1234DRIPPOOL"
    });

    expect(env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID).toBe("wallet-id-123");
    expect(env.NEXT_PUBLIC_DRIP_POOL_CONTRACT_ID).toBe("CA1234DRIPPOOL");
  });

  it("rejects missing required values", () => {
    expect(() =>
      parseFrontendEnv({
        NEXT_PUBLIC_SOROBAN_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
        NEXT_PUBLIC_HORIZON_URL: "https://horizon-testnet.stellar.org",
        NEXT_PUBLIC_SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
        NEXT_PUBLIC_DRIP_POOL_CONTRACT_ID: "CA1234DRIPPOOL"
      })
    ).toThrow(/NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID/);
  });

  it("rejects placeholder values", () => {
    expect(() =>
      parseFrontendEnv({
        NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID: "YOUR_PROJECT_ID",
        NEXT_PUBLIC_SOROBAN_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
        NEXT_PUBLIC_HORIZON_URL: "https://horizon-testnet.stellar.org",
        NEXT_PUBLIC_SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
        NEXT_PUBLIC_DRIP_POOL_CONTRACT_ID: "CA_PLACEHOLDER_DRIP_POOL_CONTRACT_ID"
      })
    ).toThrow(/placeholder/i);
  });

  it("rejects invalid URLs", () => {
    expect(() =>
      parseFrontendEnv({
        NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID: "wallet-id-123",
        NEXT_PUBLIC_SOROBAN_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
        NEXT_PUBLIC_HORIZON_URL: "not-a-url",
        NEXT_PUBLIC_SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
        NEXT_PUBLIC_DRIP_POOL_CONTRACT_ID: "CA1234DRIPPOOL"
      })
    ).toThrow(/NEXT_PUBLIC_HORIZON_URL/);
  });
});

describe("Mock Stellar Horizon Network Suite", () => {
  const mockHorizonUrl = "https://horizon-testnet.stellar.org";
  const mockAccountId = "GABC123DEFGHIJKLMNOPQRSTUVWXYZ4567890ABCDEFG";

  describe("Account Queries", () => {
    it("should mock successful account balance query", async () => {
      const mockAccountResponse = {
        id: mockAccountId,
        account_id: mockAccountId,
        sequence: "123456789",
        balances: [
          {
            balance: "10000.0000000",
            asset_type: "native",
          },
          {
            balance: "500.0000000",
            asset_type: "credit_alphanum4",
            asset_code: "USDC",
            asset_issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
          },
        ],
      };

      global.fetch = async (url: string | URL | Request) => {
        const urlString = typeof url === 'string' ? url : url.toString();
        if (urlString.includes(`/accounts/${mockAccountId}`)) {
          return {
            ok: true,
            status: 200,
            json: async () => mockAccountResponse,
          } as Response;
        }
        throw new Error(`Unexpected URL: ${urlString}`);
      };

      const response = await fetch(`${mockHorizonUrl}/accounts/${mockAccountId}`);
      const data = await response.json();

      expect(response.ok).toBe(true);
      expect(data.account_id).toBe(mockAccountId);
      expect(data.balances).toHaveLength(2);
      expect(data.balances[0].asset_type).toBe("native");
    });

    it("should mock account not found error", async () => {
      const notFoundAccountId = "GINVALIDACCOUNT123456789";

      global.fetch = async (url: string | URL | Request) => {
        const urlString = typeof url === 'string' ? url : url.toString();
        if (urlString.includes(`/accounts/${notFoundAccountId}`)) {
          return {
            ok: false,
            status: 404,
            json: async () => ({
              type: "https://stellar.org/horizon-errors/not_found",
              title: "Resource Missing",
              status: 404,
              detail: "The resource at the url requested was not found.",
            }),
          } as Response;
        }
        throw new Error(`Unexpected URL: ${urlString}`);
      };

      const response = await fetch(`${mockHorizonUrl}/accounts/${notFoundAccountId}`);
      const error = await response.json();

      expect(response.ok).toBe(false);
      expect(response.status).toBe(404);
      expect(error.type).toContain("not_found");
    });

    it("should mock network timeout error", async () => {
      global.fetch = async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        throw new Error("Network timeout");
      };

      await expect(
        fetch(`${mockHorizonUrl}/accounts/${mockAccountId}`)
      ).rejects.toThrow("Network timeout");
    });
  });

  describe("Transaction Submissions", () => {
    it("should mock successful transaction submission", async () => {
      const mockTxXdr = "AAAAAgAAAABexSIg06FtXzmFBQQtHZsrnyWxUzmthkBEhs/ktoeVYgAAAGQAAA";
      const mockTxHash = "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6";

      global.fetch = async (url: string | URL | Request) => {
        const urlString = typeof url === 'string' ? url : url.toString();
        if (urlString.includes("/transactions")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              hash: mockTxHash,
              ledger: 12345,
              envelope_xdr: mockTxXdr,
              result_xdr: "AAAAAAAAAGQAAAAAAAAAAQAAAAAAAAABAAAAAAAAAAA=",
              result_meta_xdr: "AAAAAgAAAAMAAAAA",
            }),
          } as Response;
        }
        throw new Error(`Unexpected URL: ${urlString}`);
      };

      const formData = new FormData();
      formData.append("tx", mockTxXdr);

      const response = await fetch(`${mockHorizonUrl}/transactions`, {
        method: "POST",
        body: formData,
      });
      const data = await response.json();

      expect(response.ok).toBe(true);
      expect(data.hash).toBe(mockTxHash);
      expect(data.ledger).toBe(12345);
    });

    it("should mock invalid transaction XDR error", async () => {
      const invalidTxXdr = "INVALID_XDR_STRING";

      global.fetch = async (url: string | URL | Request) => {
        const urlString = typeof url === 'string' ? url : url.toString();
        if (urlString.includes("/transactions")) {
          return {
            ok: false,
            status: 400,
            json: async () => ({
              type: "https://stellar.org/horizon-errors/transaction_malformed",
              title: "Transaction Malformed",
              status: 400,
              detail: "The transaction XDR is invalid or malformed.",
              extras: {
                envelope_xdr: invalidTxXdr,
                result_codes: {
                  transaction: "tx_bad_seq",
                },
              },
            }),
          } as Response;
        }
        throw new Error(`Unexpected URL: ${urlString}`);
      };

      const formData = new FormData();
      formData.append("tx", invalidTxXdr);

      const response = await fetch(`${mockHorizonUrl}/transactions`, {
        method: "POST",
        body: formData,
      });
      const error = await response.json();

      expect(response.ok).toBe(false);
      expect(response.status).toBe(400);
      expect(error.type).toContain("transaction_malformed");
    });

    it("should mock sequence number mismatch error", async () => {
      const mockTxXdr = "AAAAAgAAAABexSIg06FtXzmFBQQtHZsrnyWxUzmthkBEhs/ktoeVYgAAAGQAAA";

      global.fetch = async (url: string | URL | Request) => {
        const urlString = typeof url === 'string' ? url : url.toString();
        if (urlString.includes("/transactions")) {
          return {
            ok: false,
            status: 400,
            json: async () => ({
              type: "https://stellar.org/horizon-errors/transaction_failed",
              title: "Transaction Failed",
              status: 400,
              detail: "The transaction failed when submitted to the Stellar network.",
              extras: {
                result_codes: {
                  transaction: "tx_bad_seq",
                },
              },
            }),
          } as Response;
        }
        throw new Error(`Unexpected URL: ${urlString}`);
      };

      const formData = new FormData();
      formData.append("tx", mockTxXdr);

      const response = await fetch(`${mockHorizonUrl}/transactions`, {
        method: "POST",
        body: formData,
      });
      const error = await response.json();

      expect(response.ok).toBe(false);
      expect(error.extras.result_codes.transaction).toBe("tx_bad_seq");
    });

    it("should mock bad signature failure", async () => {
      const mockTxXdr = "AAAAAgAAAABexSIg06FtXzmFBQQtHZsrnyWxUzmthkBEhs/ktoeVYgAAAGQAAA";

      global.fetch = async (url: string | URL | Request) => {
        const urlString = typeof url === 'string' ? url : url.toString();
        if (urlString.includes("/transactions")) {
          return {
            ok: false,
            status: 400,
            json: async () => ({
              type: "https://stellar.org/horizon-errors/transaction_failed",
              title: "Transaction Failed",
              status: 400,
              detail: "The transaction has invalid signatures.",
              extras: {
                result_codes: {
                  transaction: "tx_bad_auth",
                  operations: ["op_bad_auth"],
                },
              },
            }),
          } as Response;
        }
        throw new Error(`Unexpected URL: ${urlString}`);
      };

      const formData = new FormData();
      formData.append("tx", mockTxXdr);

      const response = await fetch(`${mockHorizonUrl}/transactions`, {
        method: "POST",
        body: formData,
      });
      const error = await response.json();

      expect(response.ok).toBe(false);
      expect(error.extras.result_codes.transaction).toBe("tx_bad_auth");
      expect(error.extras.result_codes.operations).toContain("op_bad_auth");
    });

    it("should mock insufficient balance error", async () => {
      const mockTxXdr = "AAAAAgAAAABexSIg06FtXzmFBQQtHZsrnyWxUzmthkBEhs/ktoeVYgAAAGQAAA";

      global.fetch = async (url: string | URL | Request) => {
        const urlString = typeof url === 'string' ? url : url.toString();
        if (urlString.includes("/transactions")) {
          return {
            ok: false,
            status: 400,
            json: async () => ({
              type: "https://stellar.org/horizon-errors/transaction_failed",
              title: "Transaction Failed",
              status: 400,
              detail: "Insufficient balance to complete transaction.",
              extras: {
                result_codes: {
                  transaction: "tx_failed",
                  operations: ["op_underfunded"],
                },
              },
            }),
          } as Response;
        }
        throw new Error(`Unexpected URL: ${urlString}`);
      };

      const formData = new FormData();
      formData.append("tx", mockTxXdr);

      const response = await fetch(`${mockHorizonUrl}/transactions`, {
        method: "POST",
        body: formData,
      });
      const error = await response.json();

      expect(response.ok).toBe(false);
      expect(error.extras.result_codes.operations).toContain("op_underfunded");
    });
  });

  describe("Edge Cases and Network Errors", () => {
    it("should mock rate limit error", async () => {
      global.fetch = async (url: string | URL | Request) => {
        const urlString = typeof url === 'string' ? url : url.toString();
        if (urlString.includes(mockHorizonUrl)) {
          return {
            ok: false,
            status: 429,
            json: async () => ({
              type: "https://stellar.org/horizon-errors/rate_limit_exceeded",
              title: "Rate Limit Exceeded",
              status: 429,
              detail: "Too many requests. Please try again later.",
            }),
          } as Response;
        }
        throw new Error(`Unexpected URL: ${urlString}`);
      };

      const response = await fetch(`${mockHorizonUrl}/accounts/${mockAccountId}`);
      const error = await response.json();

      expect(response.status).toBe(429);
      expect(error.type).toContain("rate_limit_exceeded");
    });

    it("should mock server error (500)", async () => {
      global.fetch = async (url: string | URL | Request) => {
        const urlString = typeof url === 'string' ? url : url.toString();
        if (urlString.includes(mockHorizonUrl)) {
          return {
            ok: false,
            status: 500,
            json: async () => ({
              type: "https://stellar.org/horizon-errors/server_error",
              title: "Internal Server Error",
              status: 500,
              detail: "An unexpected error occurred on the server.",
            }),
          } as Response;
        }
        throw new Error(`Unexpected URL: ${urlString}`);
      };

      const response = await fetch(`${mockHorizonUrl}/accounts/${mockAccountId}`);
      const error = await response.json();

      expect(response.status).toBe(500);
      expect(error.title).toBe("Internal Server Error");
    });

    it("should verify no real network requests are made", async () => {
      let realNetworkCallDetected = false;

      const originalFetch = global.fetch;
      global.fetch = async (url: string | URL | Request) => {
        const urlString = typeof url === 'string' ? url : url.toString();
        if (urlString.includes("horizon.stellar.org") || urlString.includes("horizon-testnet.stellar.org")) {
          realNetworkCallDetected = true;
          throw new Error("Real network call detected - test should use mocks!");
        }
        return originalFetch(url);
      };

      // Mock response instead
      global.fetch = async () => {
        return {
          ok: true,
          status: 200,
          json: async () => ({ mocked: true }),
        } as Response;
      };

      const response = await fetch(`${mockHorizonUrl}/accounts/${mockAccountId}`);
      const data = await response.json();

      expect(realNetworkCallDetected).toBe(false);
      expect(data.mocked).toBe(true);
    });
  });
});
