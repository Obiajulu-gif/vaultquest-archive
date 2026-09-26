import type { ISupportedWallet } from "@creit.tech/stellar-wallets-kit";
import { kit } from "../kit.js";
import { BaseWalletProvider } from "./base.js";
import type { NetworkType, ProviderConnectionResult, SignOptions } from "./provider.js";
import { normalizeStellarNetwork, EXPECTED_NETWORK } from "../../lib/wallets.js";
import { createWalletError } from "./provider.js";

export class LedgerProvider extends BaseWalletProvider {
  readonly id = "ledger";
  readonly name = "Ledger";
  readonly type = "hardware" as const;
  protected readonly kitWalletId = "LEDGER";

  async isAvailable(): Promise<boolean> {
    if (typeof window === "undefined") return false;
    try {
      const wallets = await kit.getSupportedWallets();
      const wallet = wallets.find((w) => w.id === this.kitWalletId || w.id === "ledger");
      return Boolean(wallet?.isAvailable);
    } catch {
      return false;
    }
  }

  protected async doConnect(): Promise<ProviderConnectionResult> {
    kit.setWallet(this.kitWalletId);
    try {
      const { address } = await kit.getAddress();
      const network = await this.doGetNetwork();
      return { publicKey: address, network, providerId: this.id };
    } catch (err) {
      this.handleError(err, "connect");
    }
  }

  protected async doDisconnect(): Promise<void> {
    kit.setWallet(this.kitWalletId);
    await kit.disconnect();
  }

  protected async doGetPublicKey(): Promise<{ publicKey: string; network: NetworkType }> {
    kit.setWallet(this.kitWalletId);
    const { address } = await kit.getAddress();
    const network = await this.doGetNetwork();
    return { publicKey: address, network };
  }

  protected async doGetNetwork(): Promise<NetworkType> {
    kit.setWallet(this.kitWalletId);
    try {
      const result = await kit.getNetwork();
      return normalizeStellarNetwork(result?.network ?? result?.networkPassphrase) ?? EXPECTED_NETWORK;
    } catch {
      return EXPECTED_NETWORK;
    }
  }

  protected async doSignTransaction(xdr: string, opts?: SignOptions): Promise<string> {
    kit.setWallet(this.kitWalletId);
    try {
      const { signedTxXdr } = await kit.signTransaction(xdr, {
        network: opts?.network ?? EXPECTED_NETWORK,
      });
      return signedTxXdr;
    } catch (err) {
      this.handleError(err, "signTransaction");
    }
  }
}