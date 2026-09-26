/**
 * Provides validated, asset-aware amount handling for quest accounting.
 *
 * Uses bigint-backed values to avoid precision loss and ensures amounts
 * belonging to different assets are never combined unintentionally.
 */

export class InvalidAmountError extends Error {
  constructor(
    message: string,
    public readonly payload: unknown,
  ) {
    super(message);
    this.name = "InvalidAmountError";
  }
}

export class MixedAssetSumError extends Error {
  constructor(public readonly assetCodes: string[]) {
    super(
      `Cannot sum amounts across different assets without an explicit conversion policy: ${assetCodes.join(", ")}`,
    );

    this.name = "MixedAssetSumError";
  }
}

/**
 * Represents an amount stored in an asset's smallest unit.
 */
export class Amount {
  private constructor(
    public readonly raw: bigint,
    public readonly assetCode: string,
    public readonly decimals: number,
  ) {}

  static zero(assetCode: string, decimals: number): Amount {
    return new Amount(0n, assetCode, decimals);
  }

  /**
   * Creates an Amount instance from an action payload.
   */
  static fromPayload(
    payload: Record<string, unknown> | null | undefined,
    poolAssetCode: string,
    decimals: number,
  ): Amount {
    if (!payload) {
      throw new InvalidAmountError("Missing action payload", payload);
    }

    const amount = payload.amount;

    if (typeof amount !== "string" && typeof amount !== "number") {
      throw new InvalidAmountError(
        `amount must be a string or number, got ${typeof amount}`,
        payload,
      );
    }

    const normalizedAmount = String(amount).trim();

    if (!normalizedAmount) {
      throw new InvalidAmountError("amount is an empty string", payload);
    }

    if (!/^-?\d+$/.test(normalizedAmount)) {
      throw new InvalidAmountError(
        `amount must be an integer minor-unit value with no fractional component, got "${normalizedAmount}"`,
        payload,
      );
    }

    let parsedAmount: bigint;

    try {
      parsedAmount = BigInt(normalizedAmount);
    } catch {
      throw new InvalidAmountError(
        `amount could not be parsed as a bigint: "${normalizedAmount}"`,
        payload,
      );
    }

    if (parsedAmount < 0n) {
      throw new InvalidAmountError(
        `amount must not be negative, got "${normalizedAmount}"`,
        payload,
      );
    }

    if (!poolAssetCode) {
      throw new InvalidAmountError(
        "poolAssetCode is required and must be a non-empty string",
        payload,
      );
    }

    return new Amount(parsedAmount, poolAssetCode, decimals);
  }

  add(other: Amount): Amount {
    this.validateMatchingAsset(other);

    return new Amount(
      this.raw + other.raw,
      this.assetCode,
      this.decimals,
    );
  }

  subtract(other: Amount): Amount {
    this.validateMatchingAsset(other);

    return new Amount(
      this.raw - other.raw,
      this.assetCode,
      this.decimals,
    );
  }

  compare(other: Amount): -1 | 0 | 1 {
    this.validateMatchingAsset(other);

    if (this.raw < other.raw) return -1;
    if (this.raw > other.raw) return 1;

    return 0;
  }

  isPositive(): boolean {
    return this.raw > 0n;
  }

  /**
   * Converts the amount into a human-readable decimal string.
   */
  toDisplayString(): string {
    const isNegative = this.raw < 0n;
    const absoluteValue = isNegative ? -this.raw : this.raw;

    const padded = absoluteValue
      .toString()
      .padStart(this.decimals + 1, "0");

    const wholePart =
      padded.slice(0, padded.length - this.decimals) || "0";

    const fractionalPart =
      this.decimals > 0
        ? padded.slice(padded.length - this.decimals)
        : "";

    const sign = isNegative ? "-" : "";

    return fractionalPart
      ? `${sign}${wholePart}.${fractionalPart}`
      : `${sign}${wholePart}`;
  }

  toJSON(): {
    raw: string;
    assetCode: string;
    decimals: number;
  } {
    return {
      raw: this.raw.toString(),
      assetCode: this.assetCode,
      decimals: this.decimals,
    };
  }

  /**
   * Sums a collection of amounts belonging to the same asset.
   */
  static sum(
    amounts: Amount[],
    assetCode: string,
    decimals: number,
  ): Amount {
    return amounts.reduce(
      (total, amount) => total.add(amount),
      Amount.zero(assetCode, decimals),
    );
  }

  /**
   * Ensures two amounts belong to the same asset.
   */
  private validateMatchingAsset(other: Amount): void {
    if (this.assetCode !== other.assetCode) {
      throw new MixedAssetSumError([
        this.assetCode,
        other.assetCode,
      ]);
    }
  }
}
