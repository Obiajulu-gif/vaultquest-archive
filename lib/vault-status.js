export const ROUND_STATUS = {
  ACTIVE: "active",
  PENDING: "pending",
  COMPLETED: "completed",
};

const ROUND_STATUS_META = {
  [ROUND_STATUS.ACTIVE]: { label: "Active Round", tone: "success" },
  [ROUND_STATUS.PENDING]: { label: "Pending Round", tone: "warning" },
  [ROUND_STATUS.COMPLETED]: { label: "Completed Round", tone: "neutral" },
};

/**
 * Returns the consistent label/tone for a round status, used by both
 * vault cards and the vault detail page so status text never drifts.
 * @param {string} status
 */
export function getRoundStatusMeta(status) {
  return ROUND_STATUS_META[status] ?? ROUND_STATUS_META[ROUND_STATUS.PENDING];
}
