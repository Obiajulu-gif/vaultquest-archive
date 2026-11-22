# Stellar Wallet Connect

A plug-and-play wallet connection module for Stellar/Soroban applications.

## Features
- Modular wallet connection using `@creit.tech/stellar-wallets-kit`.
- Automated account funding checks.
- Nanostores for state management.
- Ready-to-use Astro and React components.

## Installation

1. Copy the `stellar-wallet-connect` folder to your project root.
2. Install the necessary dependencies:
   ```bash
   npm install @creit.tech/stellar-wallets-kit nanostores @nanostores/react react react-dom
   ```

## Configuration

The module uses environment variables for network configuration. Ensure your `.env` file contains:

```env
PUBLIC_SOROBAN_NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
PUBLIC_HORIZON_URL="https://horizon-testnet.stellar.org"
```

The wallet module now validates required environment configuration at startup and fails loudly if values are missing, invalid, or still set to placeholder values.
## Usage

### In Astro

Import and use the `ConnectWallet` component:

```astro
---
import ConnectWallet from "../stellar-wallet-connect/src/components/ConnectWallet.astro";
---

<nav>
  <ConnectWallet />
</nav>
```

### In React & Astro Islands

Use the dedicated `useWalletState()` hook for seamless, SSR-safe cross-island state synchronization:

```tsx
import { useWalletState } from '@vaultquest/stellar-wallet-connect';

function ProfileIsland() {
  const { isConnected, publicKey, network, isNetworkMismatch, disconnect } = useWalletState();

  if (!isConnected) {
    return <div>Not connected</div>;
  }

  return (
    <div>
      <p>Connected: {publicKey}</p>
      <p>Network: {network} {isNetworkMismatch && '(Mismatch!)'}</p>
      <button onClick={() => disconnect()}>Disconnect</button>
    </div>
  );
}
```

### Cross-Island State Synchronization (#734)

The wallet module uses a framework-agnostic singleton store (`nanostores`) coupled with `useWalletState()` and `subscribeWalletState()` to guarantee real-time synchronization between Astro page shells and isolated React island roots without flashes of incorrect state or context isolation issues. See [docs/CROSS_ISLAND_WALLET_SYNC.md](./docs/CROSS_ISLAND_WALLET_SYNC.md) for architecture details.

---

## AI Implementation Prompt

If you are using an AI assistant to integrate this into a new project, use the following prompt:

> "I have a standalone wallet connection module in `./stellar-wallet-connect`. Please integrate it into my project. 
> 1. Use `stellar-wallet-connect/src/components/ConnectWallet.astro` as the main connection button in my navbar.
> 2. Ensure `nanostores` and `@creit.tech/stellar-wallets-kit` are installed.
> 3. Map the environment variables `PUBLIC_SOROBAN_NETWORK_PASSPHRASE` and `PUBLIC_HORIZON_URL` to the project's config.
> 4. Initialize the connection on page load using `initializeConnection` from `stellar-wallet-connect/src/core/walletService.ts`."
