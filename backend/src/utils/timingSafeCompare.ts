import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Constant-time string equality check (issue #584).
 *
 * `crypto.timingSafeEqual` throws if the two buffers differ in length, and
 * comparing raw UTF-8 buffers of different lengths would itself leak the
 * length of the secret via a thrown/caught branch. To avoid that, both
 * inputs are first hashed to a fixed-length digest, then compared with
 * `crypto.timingSafeEqual` so the comparison never short-circuits on the
 * first mismatched byte and never varies its buffer size with attacker
 * input.
 */
export function timingSafeStringEqual(a: string, b: string): boolean {
  const digestA = createHash("sha256").update(a, "utf8").digest();
  const digestB = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(digestA, digestB);
}
