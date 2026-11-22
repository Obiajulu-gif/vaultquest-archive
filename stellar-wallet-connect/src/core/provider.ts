import type { NetworkType } from "../lib/wallets.js";

export interface WalletProvider {
  readonly id: string;
  readonly name: string;
  readonly type: "extension" | "mobile" | "hardware" | "walletconnect";

  isAvailable(): Promise<boolean>;
  connect(): Promise<ProviderConnectionResult>;
  disconnect(): Promise<void>;
  getPublicKey(): Promise<string>;
  getNetwork(): Promise<NetworkType>;
  signTransaction(xdr: string, opts?: SignOptions): Promise<string>;
  signAuthEntry?(challenge: string, domain: string): Promise<string>;
}

export interface ProviderConnectionResult {
  publicKey: string;
  network: NetworkType;
  providerId: string;
}

export interface SignOptions {
  network?: NetworkType;
  timeoutMs?: number;
}

export interface WalletError extends Error {
  code: WalletErrorCode;
  providerId?: string;
  originalError?: Error;
}

export type WalletErrorCode =
  | "NOT_INSTALLED"
  | "NOT_AVAILABLE"
  | "LOCKED"
  | "USER_REJECTED"
  | "TIMEOUT"
  | "NETWORK_MISMATCH"
  | "UNSUPPORTED_NETWORK"
  | "UNSUPPORTED_OPERATION"
  | "CONNECTION_FAILED"
  | "UNKNOWN_ERROR";

export function createWalletError(
  code: WalletErrorCode,
  message: string,
  providerId?: string,
  originalError?: Error
): WalletError {
  const err = new Error(message) as WalletError;
  err.code = code;
  err.providerId = providerId;
  err.originalError = originalError;
  return err;
}

export function isWalletError(err: unknown): err is WalletError {
  return err instanceof Error && "code" in err && typeof (err as WalletError).code === "string";
}

export function normalizeError(err: unknown, providerId: string): WalletError {
  if (isWalletError(err)) {
    return err;
  }
  if (err instanceof Error) {
    const message = err.message.toLowerCase();
    if (message.includes("locked") || message.includes("unlock")) {
      return createWalletError("LOCKED", err.message, providerId, err);
    }
    if (message.includes("reject") || message.includes("denied") || message.includes("cancel")) {
      return createWalletError("USER_REJECTED", err.message, providerId, err);
    }
    if (message.includes("timeout") || message.includes("timed out")) {
      return createWalletError("TIMEOUT", err.message, providerId, err);
    }
    if (message.includes("network") || message.includes("passphrase")) {
      return createWalletError("NETWORK_MISMATCH", err.message, providerId, err);
    }
    if (message.includes("not installed") || message.includes("not found") || message.includes("unavailable")) {
      return createWalletError("NOT_INSTALLED", err.message, providerId, err);
    }
    if (message.includes("unsupported") || message.includes("not supported")) {
      return createWalletError("UNSUPPORTED_OPERATION", err.message, providerId, err);
    }
    return createWalletError("UNKNOWN_ERROR", err.message, providerId, err);
  }
  return createWalletError("UNKNOWN_ERROR", String(err), providerId);
}

export interface ProviderRegistry {
  register(provider: WalletProvider): void;
  unregister(providerId: string): void;
  get(providerId: string): WalletProvider | undefined;
  getAll(): WalletProvider[];
  getAvailable(): Promise<WalletProvider[]>;
  getDefault(): WalletProvider | undefined;
  setDefault(providerId: string): void;
}

function createProviderRegistry(): ProviderRegistry {
  const providers = new Map<string, WalletProvider>();
  let defaultProviderId: string | undefined;

  return {
    register(provider) {
      providers.set(provider.id, provider);
      if (!defaultProviderId) {
        defaultProviderId = provider.id;
      }
    },
    unregister(providerId) {
      providers.delete(providerId);
      if (defaultProviderId === providerId) {
        defaultProviderId = providers.keys().next().value;
      }
    },
    get(providerId) {
      return providers.get(providerId);
    },
    getAll() {
      return Array.from(providers.values());
    },
    async getAvailable() {
      const available: WalletProvider[] = [];
      for (const provider of providers.values()) {
        if (await provider.isAvailable()) {
          available.push(provider);
        }
      }
      return available;
    },
    getDefault() {
      return defaultProviderId ? providers.get(defaultProviderId) : undefined;
    },
    setDefault(providerId) {
      if (!providers.has(providerId)) {
        throw new Error(`Provider ${providerId} not registered`);
      }
      defaultProviderId = providerId;
    },
  };
}

export const providerRegistry = createProviderRegistry();

export async function connectWithProvider(providerId: string): Promise<ProviderConnectionResult> {
  const provider = providerRegistry.get(providerId);
  if (!provider) {
    throw createWalletError("NOT_INSTALLED", `Provider ${providerId} not registered`, providerId);
  }

  if (!(await provider.isAvailable())) {
    throw createWalletError("NOT_AVAILABLE", `Provider ${providerId} not available`, providerId);
  }

  try {
    return await provider.connect();
  } catch (err) {
    throw normalizeError(err, providerId);
  }
}

export async function disconnectProvider(providerId?: string): Promise<void> {
  if (providerId) {
    const provider = providerRegistry.get(providerId);
    if (provider) {
      await provider.disconnect();
    }
  } else {
    const defaultProvider = providerRegistry.getDefault();
    if (defaultProvider) {
      await defaultProvider.disconnect();
    }
  }
}