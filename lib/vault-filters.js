export function filterVaults(vaults, filters) {
  return vaults.filter((vault) => {
    if (filters.search) {
      const search = filters.search.toLowerCase();
      const searchable = [vault.name, vault.asset, vault.strategy];
      if (!searchable.some((value) => value.toLowerCase().includes(search))) return false;
    }
    if (filters.networks.length > 0 && !filters.networks.includes(vault.network)) return false;
    if (vault.apy < filters.minApy || vault.tvl / 1_000_000 < filters.minTvl) return false;
    if (filters.lockups.length > 0) {
      const matchesLockup = filters.lockups.some((lockup) => {
        if (lockup === 0) return vault.lockup === 0;
        if (lockup === "short") return vault.lockup >= 1 && vault.lockup <= 14;
        if (lockup === "medium") return vault.lockup >= 15 && vault.lockup <= 30;
        if (lockup === "long") return vault.lockup > 30;
        return false;
      });
      if (!matchesLockup) return false;
    }
    if (filters.statuses.length > 0 && !filters.statuses.includes(vault.status)) return false;
    if (filters.strategies.length > 0 && !filters.strategies.includes(vault.strategy)) return false;
    return true;
  });
}
