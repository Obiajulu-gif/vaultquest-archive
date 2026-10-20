export { FreighterProvider } from "./freighter.js";
export { AlbedoProvider } from "./albedo.js";
export { XBullProvider } from "./xbull.js";
export { RabetProvider } from "./rabet.js";
export { LedgerProvider } from "./ledger.js";

import { FreighterProvider } from "./freighter.js";
import { AlbedoProvider } from "./albedo.js";
import { XBullProvider } from "./xbull.js";
import { RabetProvider } from "./rabet.js";
import { LedgerProvider } from "./ledger.js";
import { providerRegistry } from "./provider.js";

export function registerDefaultProviders(): void {
  providerRegistry.register(new FreighterProvider());
  providerRegistry.register(new AlbedoProvider());
  providerRegistry.register(new XBullProvider());
  providerRegistry.register(new RabetProvider());
  providerRegistry.register(new LedgerProvider());
}

export function getRegisteredProviders() {
  return providerRegistry.getAll();
}