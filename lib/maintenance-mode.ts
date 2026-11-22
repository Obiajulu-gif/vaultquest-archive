export type MaintenanceConfig = {
  message: string;
  areas: string[];
  startsAt: string;
  endsAt: string;
  enabled: boolean;
};

export function canManageMaintenance(role: string): boolean {
  return role === "admin" || role === "maintainer";
}

export function getMaintenanceBanner(config: MaintenanceConfig | null, area: string, now = new Date()): MaintenanceConfig | null {
  if (!config || !config.enabled) return null;
  const at = now.getTime();
  if (at < Date.parse(config.startsAt) || at >= Date.parse(config.endsAt)) return null;
  if (config.areas.length > 0 && !config.areas.includes(area)) return null;
  return config;
}
