import { createHash } from "node:crypto";

/** Stable audit identity without storing a wallet field's raw value. */
export function sensitiveAccessId(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
