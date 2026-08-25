import "@testing-library/jest-dom/vitest";
import { beforeAll, afterEach, afterAll } from "vitest";

// Mock Horizon Network Interceptor Setup
// This setup ensures all tests use mock responses instead of real network calls

let originalFetch: typeof global.fetch;

beforeAll(() => {
  // Store the original fetch for restoration
  originalFetch = global.fetch;
});

afterEach(() => {
  // Reset fetch to original after each test
  global.fetch = originalFetch;
});

afterAll(() => {
  // Final cleanup
  global.fetch = originalFetch;
});

// Default mock interceptor to catch any unmocked Horizon requests
global.fetch = async (url: string | URL | Request, init?: RequestInit) => {
  const urlString = typeof url === 'string' ? url : url.toString();
  
  // Detect Stellar Horizon requests
  if (urlString.includes('horizon.stellar.org') || urlString.includes('horizon-testnet.stellar.org')) {
    console.warn(`⚠️  Unmocked Horizon request detected: ${urlString}`);
    
    // Return a generic mock response to prevent real network calls
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        _links: { self: { href: urlString } },
        mocked: true,
        message: 'This is a mock response. Specify custom mock in your test.',
      }),
      text: async () => JSON.stringify({ mocked: true }),
      headers: new Headers({
        'content-type': 'application/json',
      }),
    } as Response;
  }
  
  // For non-Horizon requests, use original fetch
  return originalFetch(url, init);
};

// Helper function to create mock account responses
export function createMockAccountResponse(accountId: string, balances: any[] = []) {
  return {
    id: accountId,
    account_id: accountId,
    sequence: String(Math.floor(Math.random() * 1000000000)),
    subentry_count: 0,
    last_modified_ledger: 12345,
    balances: balances.length > 0 ? balances : [
      {
        balance: '10000.0000000',
        asset_type: 'native',
      },
    ],
    signers: [
      {
        weight: 1,
        key: accountId,
        type: 'ed25519_public_key',
      },
    ],
    flags: {
      auth_required: false,
      auth_revocable: false,
      auth_immutable: false,
    },
    thresholds: {
      low_threshold: 0,
      med_threshold: 0,
      high_threshold: 0,
    },
  };
}

// Helper function to create mock transaction responses
export function createMockTransactionResponse(txHash: string, successful = true) {
  return {
    hash: txHash,
    ledger: Math.floor(Math.random() * 1000000),
    created_at: new Date().toISOString(),
    source_account: 'GABC123DEFGHIJKLMNOPQRSTUVWXYZ4567890ABCDEFG',
    source_account_sequence: String(Math.floor(Math.random() * 1000000)),
    fee_charged: '100',
    operation_count: 1,
    envelope_xdr: 'AAAAAgAAAABexSIg06FtXzmFBQQtHZsrnyWxUzmthkBEhs/ktoeVYgAAAGQAAA==',
    result_xdr: successful
      ? 'AAAAAAAAAGQAAAAAAAAAAQAAAAAAAAABAAAAAAAAAAA='
      : 'AAAAAAAAAGT////7AAAAAA==',
    result_meta_xdr: 'AAAAAgAAAAMAAAAA',
    successful,
  };
}

// Helper function to create mock error responses
export function createMockErrorResponse(status: number, errorType: string, detail: string) {
  const errorTypes: Record<string, string> = {
    not_found: 'https://stellar.org/horizon-errors/not_found',
    transaction_failed: 'https://stellar.org/horizon-errors/transaction_failed',
    transaction_malformed: 'https://stellar.org/horizon-errors/transaction_malformed',
    rate_limit_exceeded: 'https://stellar.org/horizon-errors/rate_limit_exceeded',
    server_error: 'https://stellar.org/horizon-errors/server_error',
  };

  return {
    ok: false,
    status,
    statusText: errorType,
    json: async () => ({
      type: errorTypes[errorType] || `https://stellar.org/horizon-errors/${errorType}`,
      title: errorType.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
      status,
      detail,
    }),
    text: async () => JSON.stringify({ error: detail }),
    headers: new Headers({
      'content-type': 'application/json',
    }),
  } as Response;
}
