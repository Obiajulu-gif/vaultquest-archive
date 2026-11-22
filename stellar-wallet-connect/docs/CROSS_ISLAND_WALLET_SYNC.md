# Cross-Island Wallet State Synchronization (#734)

## Problem & Background

In Astro applications utilizing interactive UI components, each React island operates within its own isolated React root (`client:load`, `client:visible`, `client:idle`, etc.). Standard React Context cannot cross React root boundaries between isolated islands or synchronize with the Astro page shell (vanilla JavaScript / HTML). 

Without a framework-agnostic singleton store, state changes triggered in one island (e.g., connecting a wallet from a navbar, switching networks, or disconnecting) fail to propagate to other islands on the same page. Furthermore, improper hydration handling can cause flashes of incorrect state (FOUC / hydration mismatches) when server-rendered markup initializes prior to client-side store synchronization.

## Architecture

To guarantee deterministic, real-time synchronization across all island roots and the Astro shell without memory leaks or race conditions:

1. **Framework-Agnostic Singleton Store (`core/store.ts`):**
   - Built with lightweight, dependency-free `nanostores` atoms (`connectedPublicKey`, `connectedNetwork`, `isNetworkMismatch`, `multisigStatus`, `sessionStatus`, `isWalletInitialized`).
   - Resides in the global JavaScript module scope outside any React root.
   - Provides $O(1)$ updates and $O(1)$ memory overhead.

2. **Astro Shell Subscription (`components/ConnectWallet.astro`):**
   - The Astro page script subscribes directly to the reactive store via `subscribeWalletState(callback)`.
   - Any state mutation performed in any React island instantly updates the Astro shell button and UI text.
   - Dispatches disconnect/connect actions that propagate across all subscribers.

3. **React Island Hook with Hydration Guarantees (`core/useWalletState.ts`):**
   - All React islands consume state via `useWalletState()`.
   - **SSR & Pre-Hydration Safety:** Delivers a deterministic initial state during SSR, avoiding hydration mismatches and flashes of incorrect state before the client has mounted and initialized.
   - **Reactive Subscriptions:** Automatically re-renders all mounted islands whenever wallet connection, network, or session status changes anywhere on the page.

## Data Flow Diagram

```text
       ┌────────────────────────────────────────────────────────┐
       │             Singleton Store (core/store.ts)            │
       │  [connectedPublicKey, connectedNetwork, sessionStatus] │
       └──────────────┬──────────────────────────┬──────────────┘
                      │ (Pub/Sub)                │ (Reactive Bindings)
                      ▼                          ▼
       ┌──────────────────────────────┐ ┌────────────────────────────────┐
       │   Astro Page Shell           │ │   React Islands                │
       │   (ConnectWallet.astro)      │ │   - IslandNavbar               │
       │   - Subscribes via           │ │   - IslandDepositWidget        │
       │     subscribeWalletState()   │ │   - IslandAccountDrawer        │
       │   - Reflects address/network │ │   - Consumes useWalletState()  │
       └──────────────────────────────┘ └────────────────────────────────┘
```

## Hydration-Order Guarantees

- When an island mounts before `initializeConnection()` has finished reading `localStorage`, `isWalletInitialized` is `false` and initial state remains safe.
- As soon as `initializeConnection()` or `setConnection()` runs, `isWalletInitialized` transitions to `true` and the connected state propagates synchronously to all listening islands.
- Disconnecting from any island immediately invokes `disconnectWallet()` / `disconnect()`, which clears `localStorage` and resets all store atoms, reflecting instantly across every island and the Astro shell.

## Verification & Testing

Integration tests in `stellar-wallet-connect/src/core/cross-island-sync.test.tsx` verify:
- Synchronized connection across multiple independent React roots and the Astro page shell.
- Immediate cross-island disconnection reflection.
- Instant network mismatch propagation across all islands.
- Zero flash-of-incorrect-state during hydration.
