# E2E Testing Guide

This directory contains end-to-end tests for VaultQuest using Playwright.

## Test Suites

### Core Flows (`core-flows.spec.ts`)
Tests essential user workflows including wallet connection, page navigation, and accessibility.

### Route Smoke Tests (`route-smoke.spec.ts`)
Validates that all routes render correctly without crashes or errors.

### Mobile Responsiveness (`mobile-responsive.spec.ts`)
Ensures the application works correctly across different mobile devices and viewports.

### Visual Regression (`visual-regression.spec.ts`)
Captures and compares screenshots to detect unintended visual changes.

## Running Tests

### Run all tests
```bash
npx playwright test
```

### Run specific test suite
```bash
npx playwright test e2e/visual-regression.spec.ts
```

### Run tests in headed mode
```bash
npx playwright test --headed
```

### Run tests on specific browser
```bash
npx playwright test --project=chromium
npx playwright test --project=mobile-chrome
```

### Update visual regression baselines
```bash
npx playwright test --update-snapshots
```

## Visual Regression Testing

### First-time Setup
When running visual tests for the first time, baseline screenshots need to be generated:

```bash
npx playwright test e2e/visual-regression.spec.ts --update-snapshots
```

This creates a `__snapshots__` directory with baseline images.

### Reviewing Changes
If visual tests fail, Playwright generates a test report:

```bash
npx playwright show-report
```

The report includes:
- Expected screenshots (baseline)
- Actual screenshots (current)
- Diff highlighting changes

### Tolerance Configuration
Visual comparison thresholds are configured in `playwright.config.ts`:

- `maxDiffPixels`: Maximum number of pixels that can differ (default: 100)
- `threshold`: Percentage difference threshold for anti-aliasing tolerance (default: 0.2 or 20%)

### Updating Baselines
After intentional CSS or layout changes:

```bash
npx playwright test e2e/visual-regression.spec.ts --update-snapshots
```

Always review the diff before updating baselines to ensure changes are expected.

## Mobile Testing

Mobile device profiles are configured in `playwright.config.ts`:

- `mobile-chrome`: Pixel 5 (393x851)
- `mobile-safari`: iPhone 12 (390x844)
- `tablet-ipad`: iPad Pro (1024x1366)
- `mobile-android-small`: Galaxy S9+ (360x740)

### Run mobile-specific tests
```bash
npx playwright test --project=mobile-chrome
npx playwright test e2e/mobile-responsive.spec.ts
```

## Best Practices

### Visual Testing
1. Disable animations before capturing screenshots to ensure consistency
2. Wait for network idle state before taking snapshots
3. Use `fullPage: true` for full-page screenshots
4. Capture component-level screenshots for granular change detection

### Mobile Testing
1. Test hamburger menu navigation on mobile devices
2. Verify tables scroll horizontally or collapse appropriately
3. Ensure touch targets meet minimum size requirements (44x44px)
4. Test both portrait and landscape orientations where applicable

### Debugging Failed Tests
```bash
npx playwright test --debug
npx playwright test --trace on
```

View trace files:
```bash
npx playwright show-trace trace.zip
```

## CI/CD Integration

Tests run automatically on pull requests via GitHub Actions. Visual regression tests use the same baseline screenshots across environments for consistency.

### Environment Variables
- `CI`: Set to `true` in CI environments
- Affects retry logic and parallel execution

## Accessibility Testing

Core flows include accessibility checks using axe-playwright. Ensure new features pass WCAG 2.1 Level AA standards.

## Troubleshooting

### Tests timeout
Increase timeout in `playwright.config.ts` or specific test:
```typescript
test('long running test', async ({ page }) => {
  test.setTimeout(60000);
  // test code
});
```

### Flaky tests
- Use `waitForLoadState('networkidle')` before assertions
- Add explicit waits for dynamic content
- Check for race conditions in async operations

### Visual differences
- Review actual vs expected in the HTML report
- Check for font rendering differences across platforms
- Verify animation disabling is working correctly
