# Client-Side Data-Fetching Conventions

This document outlines the standard patterns for fetching data on the client, managing asynchronous state (loading, error, empty), and integrating with the application's UI patterns (like toasts). 

Following these conventions ensures consistency across the codebase and prevents fragmented error-handling or loading states.

## 1. Hook Location and Naming

- **UI and Transaction Hooks**: Custom hooks that deal with UI state, transactions, or specific feature logic should live in the `hooks/` directory (e.g., `hooks/useVaultData.ts`, `hooks/useTransactionToast.js`).
- **Shared/Utility Data Hooks**: Generic data-fetching utilities or shared client services should be placed in `lib/` (e.g., `lib/tx/useTxStatus.ts`).
- **Naming**: All custom hooks must be prefixed with `use` (e.g., `useVaultYield`, `useUserPortfolio`).

## 2. Managing Loading, Error, and Empty States

Every data-fetching hook must expose a predictable set of properties to components so that the UI can reliably show spinners, errors, or empty states.

- **`isLoading`**: A boolean indicating if the data is currently being fetched for the first time.
- **`isError`**: A boolean indicating if the fetch operation failed.
- **`error`**: The actual error object or message (if `isError` is true).
- **`hasPartialFailure`**: (Optional) Use this boolean when a hook fetches multiple endpoints/contracts and only some fail.

*Example Return Type:*
```typescript
return {
  data: result.data,
  isLoading: result.isPending,
  isError: result.isError,
  error: result.error,
  hasPartialFailure: false,
};
```

## 3. Toast-on-Error Policy

When a background data-fetch or a transaction fails, it's crucial to provide immediate, actionable feedback to the user without breaking the entire UI.

- Use the `useTransactionToast` hook to present error states.
- Do not blindly wrap entire pages in error boundaries for minor fetching errors; instead, gracefully degrade the UI (e.g., show a placeholder or empty state) and display a toast.
- For user-initiated actions (e.g., clicking "Refresh" or submitting a transaction), always use the toast lifecycle: `pending` -> `success` / `error`.

```javascript
import { useTransactionToast } from "@/hooks/useTransactionToast";

// Inside component
const { addToast } = useTransactionToast();

if (error) {
  addToast("error", "Data Fetch Failed", "Unable to retrieve the latest vault data.", error);
}
```

## 4. SSR-Safety (Window Guards)

Next.js will attempt to server-side render components by default. When your hooks rely on browser-specific APIs (like `window`, `localStorage`, or wallet connections), you must ensure they are SSR-safe.

- **`"use client"` Directive**: Any file defining a hook that uses React state (`useState`, `useEffect`), context, or browser APIs must include `"use client";` at the very top.
- **Window Checks**: If a utility function or hook executes immediately (outside of a `useEffect`), wrap browser API calls in a check:
  ```javascript
  if (typeof window !== "undefined") {
    // safe to use window or localStorage
  }
  ```

## 5. Wiring Components to `app/api/*` Routes (Worked Example)

Here is a full example of a custom hook fetching from an API route and wiring it to a React component.

### The Hook (`hooks/useRecentActivity.ts`)

```typescript
"use client";

import { useState, useEffect } from "react";
import { useTransactionToast } from "@/hooks/useTransactionToast";

export function useRecentActivity(vaultId: string) {
  const [data, setData] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isError, setIsError] = useState(false);
  const [error, setError] = useState(null);
  const { addToast } = useTransactionToast();

  useEffect(() => {
    let isMounted = true;
    setIsLoading(true);

    async function fetchActivity() {
      try {
        const response = await fetch(`/api/vaults/${vaultId}/activity`);
        if (!response.ok) throw new Error("Failed to fetch activity");
        
        const result = await response.json();
        if (isMounted) {
          setData(result);
          setIsError(false);
        }
      } catch (err) {
        if (isMounted) {
          setIsError(true);
          setError(err);
          addToast("error", "Activity Feed Error", "Could not load recent activity.", err);
        }
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    }

    fetchActivity();

    return () => {
      isMounted = false;
    };
  }, [vaultId, addToast]);

  return { data, isLoading, isError, error };
}
```

### The Component (`app/vaults/[id]/page.tsx`)

```tsx
"use client";

import { useRecentActivity } from "@/hooks/useRecentActivity";

export default function VaultActivity({ params }) {
  const { data, isLoading, isError } = useRecentActivity(params.id);

  if (isLoading) {
    return <div className="animate-pulse">Loading activity...</div>;
  }

  if (isError) {
    // The toast already notified the user, gracefully show a fallback UI here
    return <div>Unable to display activity at this time.</div>;
  }

  if (!data || data.length === 0) {
    return <div>No recent activity found.</div>;
  }

  return (
    <ul>
      {data.map((item) => (
        <li key={item.id}>{item.description}</li>
      ))}
    </ul>
  );
}
```
