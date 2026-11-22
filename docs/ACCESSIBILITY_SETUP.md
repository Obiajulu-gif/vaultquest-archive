# Accessibility Setup & Testing Guide

This guide explains how to set up and run accessibility checks for VaultQuest.

## Quick Start

### 1. Install Dependencies

No additional dependencies required for basic accessibility support. Component library uses native semantic HTML.

### 2. Run Automated Checks

```bash
# Scan codebase for accessibility issues
npm run a11y:check

# Or directly:
node scripts/check-accessibility.js
```

### 3. Run Component Tests

```bash
# Test accessible form components
npm test -- app/tests/accessibility.spec.ts

# Watch mode
npm test -- app/tests/accessibility.spec.ts --watch
```

### 4. Manual Testing

Use browser tools and screen readers (see below).

---

## Automated Checks

### npm Script

Add to `package.json`:

```json
{
  "scripts": {
    "a11y:check": "node scripts/check-accessibility.js",
    "a11y:check:watch": "nodemon --ext jsx scripts/check-accessibility.js",
    "test:a11y": "vitest run app/tests/accessibility.spec.ts"
  }
}
```

### What the Script Checks

1. **Page Headings**: Verifies `<h1>` on all page components
2. **Form Labels**: Ensures inputs have `<label>` or `aria-label`
3. **Error Handling**: Checks for `aria-describedby` on error messages
4. **Semantic HTML**: Flags non-semantic clickable divs
5. **Table Structure**: Validates `<th>` and `scope` attributes
6. **Alt Text**: Verifies images have `alt` attributes
7. **Skip Links**: Checks for bypass blocks
8. **Component Usage**: Encourages AccessibleField/Button components

### Example Output

```
✅ PASS [dashboard/page.jsx]: Page has <h1>
⚠️  WARN [vaults/list.jsx]: Table headers missing scope attributes
❌ FAIL [deposit/form.jsx]: Found 2 non-semantic clickable divs (use <button> instead)

Summary:
✅ Passed:    24
⚠️  Warnings: 8
❌ Failed:    2

❌ AUDIT FAILED: Critical accessibility issues found
```

---

## Browser Extensions

### axe DevTools

[Download for Chrome/Firefox/Edge](https://www.deque.com/axe/devtools/)

**Usage**:

1. Install extension
2. Open DevTools (F12)
3. Click "axe DevTools" tab
4. Click "Scan ALL of my page"
5. Review issues by severity

**Expected Results**:
- Dashboard: 0 Critical issues
- Vaults list: 0 Critical issues
- Deposit form: 0 Critical issues
- Account page: 0 Critical issues

### WAVE

[Download for Chrome/Firefox/Edge](https://wave.webaim.org/extension/)

**Usage**:

1. Install extension
2. Navigate to page
3. Click WAVE icon
4. Review errors, contrast, structure

---

## Manual Keyboard Testing

### Test Plan

For each primary screen (Dashboard, Vaults, Deposit, Account):

1. **Open the page in browser**
2. **Press Tab repeatedly** to navigate all interactive elements
3. **Verify each element**:
   - ✅ Has visible focus indicator
   - ✅ Is reachable via Tab
   - ✅ Tab order is logical (left→right, top→bottom)
   - ✅ No focus traps (can Tab out of any element)
4. **Test keyboard shortcuts**:
   - ✅ Enter key on buttons/links
   - ✅ Spacebar on buttons/checkboxes
   - ✅ Escape to close modals
   - ✅ Arrow keys in lists/tabs (if implemented)

### Common Issues to Check

| Element | Keyboard Test | Expected Behavior |
|---------|---------------|-------------------|
| Button | Tab + Enter | Activates button |
| Link | Tab + Enter | Navigates to link |
| Checkbox | Tab + Space | Toggles checkbox |
| Input | Tab + type | Accepts input |
| Modal | Tab (inside) | Stays inside modal |
| Select | Tab + arrows | Selects option |

### Focus Indicator Checklist

- [ ] Focus outline is visible (not removed)
- [ ] Focus outline contrasts with background (4.5:1 minimum)
- [ ] Focus outline is not too faint (2px minimum)
- [ ] Focus outline matches design system (blue by default)

---

## Screen Reader Testing

### Windows: NVDA

[Download free](https://www.nvaccess.org/)

**Basic Usage**:

```bash
# Start NVDA
C:\Program Files (x86)\NVDA\nvda.exe

# In browser:
# - Press Insert+Down Arrow to read page
# - Press H to jump to next heading
# - Press B to jump to next button
# - Press F to jump to next form field
```

**Test Checklist**:

- [ ] Page title announced (document title)
- [ ] H1 heading announced
- [ ] Navigation landmarks announced
- [ ] Form field labels announced
- [ ] Required fields indicated
- [ ] Error messages announced
- [ ] Status changes announced

### macOS: VoiceOver

Built into macOS.

**Basic Usage**:

```bash
# Toggle VoiceOver
Cmd+F5

# In browser:
# - Use VO+Right Arrow to read page (VO = Ctrl+Option)
# - Use VO+Up Arrow to jump to next heading
# - Use VO+B to jump to next button
# - Use VO+F to jump to next form field
```

### Test Script for Screen Reader

```
Page loads → Listen for announcement
  ✅ "VaultQuest Dashboard" or similar

Press H to jump to next heading
  ✅ H1: "VaultQuest Dashboard"
  ✅ H2: "Recent Vaults"
  ✅ H2: "Your Portfolio"

Press F to jump to next form field
  ✅ "Amount to deposit, required, edit text"
  ✅ "Minimum deposit $100"

Fill in invalid data → Listen for error
  ✅ "Amount must be at least $100, alert"

Press Tab to navigate button
  ✅ "Deposit button"

Press Enter
  ✅ Dialog opens
  ✅ "Confirm deposit dialog" announced
```

---

## Color Contrast Testing

### WebAIM Contrast Checker

[Online tool](https://webaim.org/resources/contrastchecker/)

**Usage**:

1. Extract foreground color from page (e.g., `#1F2937`)
2. Extract background color (e.g., `#FFFFFF`)
3. Enter both colors
4. Verify "WCAG AA" or "WCAG AAA" pass

**Threshold**:
- Normal text: 4.5:1 minimum
- Large text (18pt+): 3:1 minimum
- Graphics/UI components: 3:1 minimum

### Bulk Check Script (Future)

```bash
npm run a11y:contrast
# Extracts all colors from CSS and checks contrast
```

---

## Continuous Integration

### Pre-commit Hook

Add to `.husky/pre-commit`:

```bash
npm run a11y:check
npm run test:a11y
```

### CI/CD Pipeline

In `.github/workflows/accessibility.yml`:

```yaml
name: Accessibility Checks

on: [push, pull_request]

jobs:
  a11y:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
      - run: npm install
      - run: npm run a11y:check
      - run: npm run test:a11y
```

---

## Accessible Component Library

VaultQuest provides accessible form components in `components/ui/AccessibleField.jsx`:

### Components Available

- **AccessibleField**: Input with label, error, help text
- **AccessibleButton**: Semantic button with focus styling
- **AccessibleCheckbox**: Checkbox with proper labeling
- **AccessibleSelect**: Select dropdown with accessibility
- **AccessibleAlert**: Live region for status messages

### Usage Example

```jsx
import {
  AccessibleField,
  AccessibleButton,
  AccessibleCheckbox,
} from "@/components/ui/AccessibleField";

export default function DepositForm() {
  const [amount, setAmount] = useState("");
  const [error, setError] = useState("");
  const [agreed, setAgreed] = useState(false);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (amount < 100) {
      setError("Minimum deposit is $100");
      return;
    }
    // Submit form
  };

  return (
    <form onSubmit={handleSubmit}>
      <h1>Deposit to Vault</h1>

      <AccessibleField
        id="amount"
        label="Amount (USDC)"
        type="number"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        error={error}
        helpText="Minimum deposit: $100"
        required
      />

      <AccessibleCheckbox
        id="agree"
        label="I agree to the terms and conditions"
        checked={agreed}
        onChange={(e) => setAgreed(e.target.checked)}
        required
      />

      <AccessibleButton type="submit">
        Confirm Deposit
      </AccessibleButton>
    </form>
  );
}
```

---

## Troubleshooting

### Focus Indicator Not Visible

**Problem**: Focused elements don't show outline

**Solution**: Check `globals.css` has focus styles:

```css
:focus-visible {
  outline: 3px solid #4F46E5;
  outline-offset: 2px;
}
```

### Form Errors Not Announced

**Problem**: Screen reader doesn't announce validation errors

**Solution**: Use `role="alert"` on error element:

```jsx
<div
  id="amount-error"
  role="alert"
  aria-live="polite"
>
  {error}
</div>
```

### Tables Not Readable

**Problem**: Screen reader can't navigate table columns

**Solution**: Add proper table structure:

```jsx
<table>
  <thead>
    <tr>
      <th scope="col">Column 1</th>
      <th scope="col">Column 2</th>
    </tr>
  </thead>
  <tbody>
    {data.map(row => (
      <tr key={row.id}>
        <td>{row.col1}</td>
        <td>{row.col2}</td>
      </tr>
    ))}
  </tbody>
</table>
```

### Button Without Label

**Problem**: Screen reader announces "button" with no context

**Solution**: Add aria-label:

```jsx
<button aria-label="Deposit to savings vault">
  Deposit
</button>
```

---

## Resources

- [WCAG 2.1 Guidelines](https://www.w3.org/WAI/WCAG21/quickref/)
- [ARIA Authoring Practices](https://www.w3.org/WAI/ARIA/apg/)
- [WebAIM Articles](https://webaim.org/articles/)
- [Deque University](https://dequeuniversity.com/)
- [Testing Accessibility](https://testingaccessibility.com/)

---

## Contributing

When adding new features:

1. Run `npm run a11y:check` before committing
2. Test keyboard navigation manually
3. Test with screen reader (NVDA or VoiceOver)
4. Use AccessibleField/Button components for forms
5. Add alt text to images
6. Document accessibility decisions in PR

For questions, see [ACCESSIBILITY_AUDIT.md](./ACCESSIBILITY_AUDIT.md).
