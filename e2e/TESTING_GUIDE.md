# VaultQuest E2E Testing Guide

## Quick Start

```bash
# Run all tests
npm run test:e2e

# Run with UI (recommended for development)
npm run test:e2e:ui

# Run specific test file
npx playwright test e2e/wallet-disconnect.spec.ts

# Run single test by name
npx playwright test -g "Dashboard shows connect wallet button"
```

## Wallet Disconnect Test Flow

```
┌─────────────────────────────────────────────────────────────┐
│                    Wallet Disconnect Tests                   │
└─────────────────────────────────────────────────────────────┘

Test 1: Dashboard Flow
─────────────────────────
1. Navigate to /app
2. Connect wallet (mock)
3. Verify: "View All Prizes" visible ✓
4. Disconnect wallet
5. Verify: "Connect wallet" button visible ✓
6. Verify: Connected UI hidden ✓

Test 2: Account Page Flow
─────────────────────────
1. Navigate to /app/account?mockConnected=true
2. Verify: "Your profile" visible ✓
3. Navigate to /app/account (disconnect simulation)
4. Verify: Connect prompt visible ✓
5. Verify: Account content hidden ✓

Test 3: Activity Page Flow
─────────────────────────
1. Navigate to /app/activity (disconnected)
2. Verify: Connect prompt visible ✓
3. Verify: "Connect wallet" button visible ✓

Test 4: Vault Detail Flow
─────────────────────────
1. Navigate to /app/vaults/1
2. Verify: Connect prompt visible ✓

Test 5: Header Status Flow
─────────────────────────
1. Navigate to /app
2. Connect wallet (mock)
3. Disconnect wallet
4. Verify: Header shows "Connect Wallet" ✓

Test 6: Navigation Persistence
─────────────────────────
1. Connect wallet → Disconnect
2. Navigate to /app/prizes → Verify disconnected ✓
3. Navigate to /app/vaults → Verify disconnected ✓
4. Navigate to /app/activity → Verify disconnected ✓

Test 7: Reconnect Guidance
─────────────────────────
1. Navigate to /app/account?mockConnected=true
2. Navigate to /app/account (disconnect)
3. Verify: Reconnect button visible ✓

Test 8: Wallet Address Removal
─────────────────────────
1. Connect wallet
2. Disconnect wallet
3. Verify: No wallet address visible in UI ✓

Test 9: Balance Removal
─────────────────────────
1. Navigate to account (connected)
2. Disconnect wallet
3. Verify: Balance info hidden ✓

Test 10: Connect Button Clickability
─────────────────────────
1. Connect → Disconnect
2. Verify: Connect button enabled ✓
3. Click connect button
4. Verify: Button is interactive ✓
```

## Test Organization

```
e2e/
├── wallet-disconnect.spec.ts    ← Wallet disconnect tests
├── core-flows.spec.ts           ← Core user flows
├── route-smoke.spec.ts          ← Route smoke tests
├── helpers/
│   └── wallet-mock.ts           ← Wallet mock utilities
├── README.md                    ← Test documentation
├── TESTING_GUIDE.md             ← This file
└── wallet-disconnect-test-summary.md  ← Implementation details
```

## Helper Functions

### `injectMockWallet(page, address?)`
Injects a mock Ethereum wallet for testing.

```typescript
import { injectMockWallet } from './helpers/wallet-mock';

await injectMockWallet(page);
// Now the page has window.ethereum available
```

### `simulateWalletDisconnect(page)`
Simulates wallet disconnection by triggering events.

```typescript
import { simulateWalletDisconnect } from './helpers/wallet-mock';

await simulateWalletDisconnect(page);
// Triggers accountsChanged([]) and disconnect events
```

### Custom Helpers in wallet-disconnect.spec.ts

#### `connectWallet(page)`
Connects the mock wallet via UI.

```typescript
await connectWallet(page);
// Clicks "Connect wallet" button
```

#### `disconnectWallet(page)`
Disconnects wallet via UI button.

```typescript
await disconnectWallet(page);
// Clicks disconnect button in header
```

## Writing New Tests

### Basic Template

```typescript
import { test, expect } from '@playwright/test';
import { injectMockWallet } from './helpers/wallet-mock';

test.describe('My Feature', () => {
  test('should do something', async ({ page }) => {
    // Setup
    await page.goto('/app');
    await injectMockWallet(page);
    
    // Action
    await page.click('button:has-text("Some Action")');
    
    // Assert
    await expect(page.locator('text=Expected Result')).toBeVisible();
  });
});
```

### Best Practices

1. **Use descriptive test names**
   ```typescript
   ✅ test('Dashboard shows connect wallet button after disconnect', ...)
   ❌ test('test disconnect', ...)
   ```

2. **Add timeouts for async operations**
   ```typescript
   await expect(element).toBeVisible({ timeout: 10000 });
   ```

3. **Test both positive and negative cases**
   ```typescript
   await expect(connectedButton).toBeVisible();
   await expect(disconnectedButton).not.toBeVisible();
   ```

4. **Use helper functions for common actions**
   ```typescript
   await connectWallet(page);  // ✅
   // Instead of repeating the same code in each test ❌
   ```

5. **Wait for page load states**
   ```typescript
   await page.goto('/app');
   await page.waitForLoadState('networkidle');
   ```

## Debugging

### Visual Debugging
```bash
# See the browser
npm run test:e2e:headed

# Step through tests
npx playwright test --debug

# Pause at specific point
await page.pause();
```

### Screenshots
```typescript
// Take screenshot for debugging
await page.screenshot({ path: 'debug.png' });

// Full page screenshot
await page.screenshot({ path: 'debug.png', fullPage: true });
```

### Console Logs
```typescript
// Listen to console messages
page.on('console', msg => console.log('PAGE LOG:', msg.text()));
```

### Network Inspection
```typescript
// Monitor network requests
page.on('request', request => console.log('>>', request.method(), request.url()));
page.on('response', response => console.log('<<', response.status(), response.url()));
```

## CI/CD Integration

Tests run automatically on:
- Pull Requests
- Pushes to main branch
- Manual workflow dispatch

See `.github/workflows/frontend.yml` for configuration.

### Local CI Simulation
```bash
# Run tests like CI does
CI=true npm run test:e2e
```

## Troubleshooting

### Test Timeout
```typescript
// Increase timeout for slow operations
test.setTimeout(60000); // 60 seconds

// Or for specific action
await expect(element).toBeVisible({ timeout: 30000 });
```

### Element Not Found
```typescript
// Use more specific selectors
await page.locator('button[aria-label="Connect wallet"]');

// Or wait for element
await page.waitForSelector('button:has-text("Connect")');
```

### Flaky Tests
```typescript
// Add retry configuration
test.describe.configure({ retries: 2 });

// Or wait for stable state
await page.waitForLoadState('networkidle');
```

### Mock Not Working
```typescript
// Ensure mock is injected BEFORE navigation
await injectMockWallet(page);
await page.goto('/app');

// Not the other way around ❌
```

## Resources

- [Playwright Documentation](https://playwright.dev/)
- [Playwright Best Practices](https://playwright.dev/docs/best-practices)
- [Debugging Guide](https://playwright.dev/docs/debug)
- [axe-playwright](https://github.com/abhinaba-ghosh/axe-playwright) for accessibility testing

## Support

For questions or issues with tests:
1. Check test output and error messages
2. Run with `--headed` flag to see what's happening
3. Use `--debug` flag to step through
4. Check this guide and README.md
5. Review existing tests for patterns
