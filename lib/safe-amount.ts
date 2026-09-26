/**
 * Exact token amount arithmetic utilities (#599).
 *
 * All financial calculations in VaultQuest must use these utilities
 * instead of JavaScript `Number` arithmetic to avoid precision loss
 * with i128 contract values.
 *
 * The contract stores amounts as i128 (128-bit signed integers).
 * JavaScript Number can only safely represent integers up to 2^53.
 * For Stellar assets with up to 18 decimals, even modest deposit
 * amounts can exceed this range. This module provides BigInt-based
 * arithmetic with conversion helpers.
 */

/**
 * A BigInt-based representation of an exact token amount.
 * Use `fromHuman` to convert from human-readable decimal strings,
 * and `toContract` / `toDisplay` to convert back.
 */
export class ExactAmount {
  private readonly value: bigint;

  private constructor(value: bigint) {
    this.value = value;
  }

  /** Create from a raw i128 value (as string or bigint). */
  static fromRaw(value: string | bigint): ExactAmount {
    return new ExactAmount(BigInt(value));
  }

  /**
   * Convert a human-readable decimal string (e.g. "123.456") to
   * on-chain units given the asset's decimal count.
   *
   * Example: fromHuman("123.456", 7) => 1234560000n
   *
   * Rejects inputs that would lose precision (fractional digits
   * exceeding the asset's decimals).
   */
  static fromHuman(human: string, decimals: number): ExactAmount {
    if (!/^-?\d+(\.\d+)?$/.test(human)) {
      throw new Error(`Invalid human amount: ${human}`);
    }

    const [intPart, fracPart = ""] = human.split(".");
    const fracPadded = fracPart.padEnd(decimals, "0").slice(0, decimals);

    if (fracPart.length > decimals) {
      throw new Error(
        `Amount ${human} has ${fracPart.length} fractional digits but asset only supports ${decimals}`
      );
    }

    const sign = intPart.startsWith("-") ? "-" : "";
    const absInt = intPart.replace("-", "");
    const raw = `${sign}${absInt}${fracPadded}`;
    return new ExactAmount(BigInt(raw));
  }

  /** Convert to on-chain i128 string. */
  toContract(): string {
    return this.value.toString();
  }

  /** Convert to human-readable decimal string. */
  toDisplay(decimals: number): string {
    const sign = this.value < 0n ? "-" : "";
    const abs = this.value < 0n ? -this.value : this.value;
    const str = abs.toString().padStart(decimals + 1, "0");
    const intPart = str.slice(0, str.length - decimals);
    const fracPart = str.slice(str.length - decimals);
    if (decimals === 0) {
      return `${sign}${intPart}`;
    }
    return `${sign}${intPart}.${fracPart}`;
  }

  /** The raw bigint value. */
  toBigInt(): bigint {
    return this.value;
  }

  add(other: ExactAmount): ExactAmount {
    return new ExactAmount(this.value + other.value);
  }

  sub(other: ExactAmount): ExactAmount {
    return new ExactAmount(this.value - other.value);
  }

  mulScalar(scalar: number): ExactAmount {
    return new ExactAmount(this.value * BigInt(Math.round(scalar)));
  }

  divScalar(scalar: number): ExactAmount {
    if (scalar === 0) throw new Error("Division by zero");
    return new ExactAmount(this.value / BigInt(Math.round(scalar)));
  }

  isPositive(): boolean {
    return this.value > 0n;
  }

  isZero(): boolean {
    return this.value === 0n;
  }

  isNegative(): boolean {
    return this.value < 0n;
  }

  abs(): ExactAmount {
    return new ExactAmount(this.value < 0n ? -this.value : this.value);
  }

  max(other: ExactAmount): ExactAmount {
    return this.value >= other.value ? this : other;
  }

  min(other: ExactAmount): ExactAmount {
    return this.value <= other.value ? this : other;
  }

  equals(other: ExactAmount): boolean {
    return this.value === other.value;
  }

  greaterThan(other: ExactAmount): boolean {
    return this.value > other.value;
  }

  lessThan(other: ExactAmount): boolean {
    return this.value < other.value;
  }

  toString(): string {
    return this.value.toString();
  }
}

/**
 * Compute pro-rata share with integer division, preserving dust in the
 * numerator (never over-distributing).
 *
 * Formula: floor((total * part) / whole)
 *
 * Returns 0 when whole <= 0 or part <= 0.
 */
export function proRataShare(total: ExactAmount, part: ExactAmount, whole: ExactAmount): ExactAmount {
  if (whole.isZero() || whole.isNegative() || part.isNegative()) {
    return ExactAmount.fromRaw(0n);
  }
  const totalBI = total.toBigInt();
  const partBI = part.toBigInt();
  const wholeBI = whole.toBigInt();
  return ExactAmount.fromRaw((totalBI * partBI) / wholeBI);
}

/**
 * Safe percentage calculation: returns (numerator * 10000) / denominator
 * in basis points, truncated to integer.
 */
export function toBasisPoints(numerator: ExactAmount, denominator: ExactAmount): number {
  if (denominator.isZero()) return 0;
  const result = (numerator.toBigInt() * 10000n) / denominator.toBigInt();
  return Number(result);
}

/**
 * Parse a contract i128 string value to an ExactAmount.
 */
export function fromContract(value: string): ExactAmount {
  return ExactAmount.fromRaw(value);
}
