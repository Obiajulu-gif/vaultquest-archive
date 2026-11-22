import type { WalletProvider, ProviderConnectionResult, NetworkType, SignOptions, WalletErrorCode } from "./provider.js";
import { createWalletError } from "./provider.js";
import type { ISupportedWallet } from "@creit.tech/stellar-wallets-kit";

export abstract class BaseWalletProvider implements WalletProvider {
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly type: "extension" | "mobile" | "hardware" | "walletconnect";
  protected abstract kitWalletId: string;

  abstract isAvailable(): Promise<boolean>;

  async connect(): Promise<ProviderConnectionResult> {
    const available = await this.isAvailable();
    if (!available) {
      throw createWalletError("NOT_AVAILABLE", `${this.name} is not available`, this.id);
    }
    return this.doConnect();
  }

  protected abstract doConnect(): Promise<ProviderConnectionResult>;

  async disconnect(): Promise<void> {
    await this.doDisconnect();
  }

  protected abstract doDisconnect(): Promise<void>;

  async getPublicKey(): Promise<string> {
    const result = await this.doGetPublicKey();
    return result.publicKey;
  }

  protected abstract doGetPublicKey(): Promise<{ publicKey: string; network: NetworkType }>;

  async getNetwork(): Promise<NetworkType> {
    return this.doGetNetwork();
  }

  protected abstract doGetNetwork(): Promise<NetworkType>;

  async signTransaction(xdr: string, opts?: SignOptions): Promise<string> {
    return this.doSignTransaction(xdr, opts);
  }

  protected abstract doSignTransaction(xdr: string, opts?: SignOptions): Promise<string>;

  async signAuthEntry?(challenge: string, domain: string): Promise<string> {
    throw createWalletError("UNSUPPORTED_OPERATION", "signAuthEntry not supported", this.id);
  }

  protected getKitWallet(): ISupportedWallet | undefined {
    return undefined;
  }

  protected handleError(err: unknown, operation: string): never {
    const message = err instanceof Error ? err.message : String(err);
    const lower = message.toLowerCase();

    if (lower.includes("locked") || lower.includes("unlock")) {
      throw createWalletError("LOCKED", `${this.name} is locked: ${message}`, this.id, err instanceof Error ? err : undefined);
    }
    if (lower.includes("reject") || lower.includes("denied") || lower.includes("cancel")) {
      throw createWalletError("USER_REJECTED", `User rejected ${operation}`, this.id, err instanceof Error ? err : undefined);
    }
    if (lower.includes("timeout") || lower.includes("timed out")) {
      throw createWalletError("TIMEOUT", `${operation} timed out`, this.id, err instanceof Error ? err : undefined);
    }
    if (lower.includes("network") || lower.includes("passphrase")) {
      throw createWalletError("NETWORK_MISMATCH", `Network mismatch: ${message}`, this.id, err instanceof Error ? err : undefined);
    }
    if (lower.includes("unsupported") || lower.includes("not supported")) {
      throw createWalletError("UNSUPPORTED_OPERATION", `${operation} not supported`, this.id, err instanceof Error ? err : undefined);
    }
    throw createWalletError("UNKNOWN_ERROR", `${operation} failed: ${message}`, this.id, err instanceof Error ? err : undefined);
  }
}