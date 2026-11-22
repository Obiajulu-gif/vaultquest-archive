/**
 * Concurrency test helpers (#790).
 *
 * Small, deterministic primitives for driving concurrent mutation paths
 * in tests without relying on real timers or wall-clock jitter.
 *
 * The goal is to make race conditions *reproducible*: every helper here
 * either forces an interleaving or runs a batch of operations that must
 * preserve a domain invariant regardless of order.
 */

/**
 * Runs `attempts` copies of `fn` concurrently and returns their settled
 * results in input order. Never rejects for a failed copy — the caller
 * inspects `status`/`reason` on each result.
 */
export async function runConcurrently<T>(
  attempts: number,
  fn: (index: number) => Promise<T>
): Promise<PromiseSettledResult<T>[]> {
  const tasks = Array.from({ length: attempts }, ( _, i) => fn(i));
  return Promise.allSettled(tasks);
}

/**
 * Counts how many settled results fulfilled a predicate. Useful for
 * asserting "exactly one winner" or "exactly N successes" in a race.
 */
export function countFulfilled<T>(
  results: PromiseSettledResult<T>[],
  predicate: (value: T) => boolean = () => true
): number {
  return results.filter(
    (r) => r.status === "fulfilled" && predicate(r.value)
  ).length;
}

/**
 * Collects the rejection reasons from a settled batch, in input order.
 */
export function rejections<T>(results: PromiseSettledResult<T>[]): unknown[] {
  return results
    .filter((r): r is PromiseRejectedResult => r.status === "rejected")
    .map((r) => r.reason);
}

/**
 * A single-use barrier that lets the caller park a task until a later
 * point in the test. This is the building block for deterministic race
 * simulations: instead of hoping two async operations interleave by
 * luck, the test explicitly controls when each one proceeds.
 */
export class Barrier {
  private waiters: Array<() => void> = [];
  private released = false;

  /** Resolves once the barrier is released. */
  wait(): Promise<void> {
    if (this.released) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  /** Releases every waiter and any future waiters. */
  release(): void {
    this.released = true;
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve();
  }

  /** How many tasks are currently parked on the barrier. */
  get waitingCount(): number {
    return this.waiters.length;
  }
}

/**
 * A counter that can be advanced and awaited on. Used to assert that
 * every concurrent task reached a particular phase before any of them
 * proceeded — the classic "all ready, then go" pattern.
 */
export class Latch {
  private count = 0;
  private target: number;
  private resolvers: Array<() => void> = [];

  constructor(target: number) {
    if (target <= 0) throw new Error("Latch target must be positive");
    this.target = target;
  }

  /** Records one arrival. Resolves waiters once the target is reached. */
  arrive(): void {
    this.count++;
    if (this.count >= this.target) {
      const resolvers = this.resolvers;
      this.resolvers = [];
      for (const resolve of resolvers) resolve();
    }
  }

  /** Resolves once `arrive()` has been called `target` times. */
  wait(): Promise<void> {
    if (this.count >= this.target) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.resolvers.push(resolve);
    });
  }

  get arrivals(): number {
    return this.count;
  }
}

/**
 * A deterministic clock that only moves when the test says so. This
 * lets tests expire leases without sleeping and without any real
 * time dependency, which is what makes the concurrency tests reliable
 * in CI.
 */
export class DeterministicClock {
  private current: number;

  constructor(start: number = 0|| Date.now()) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  date(): Date {
    return new Date(this.current);
  }

  advance(ms: number): void {
    if (ms < 0) throw new Error("Cannot advance clock backwards");
    this.current += ms;
  }

  set(value: number): void {
    this.current = value;
  }
}

/**
 * A micro-task scheduler that yields between concurrent tasks at
 * explicit points. This makes it possible to interleave two operations
 * that would otherwise complete atomically in a single await chain.
 */
export async function yieldTo(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/**
 * Runs a function and asserts it fails with a specific error code.
 * This keeps the concurrency tests explicit about which conflicting
 * requests are expected to be rejected versus which are expected to
 * succeed.
 */
export async function expectCodedError<T>(
  fn: () => Promise<T>,
  code: string
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    const actual = (err as { code?: unknown })?.code;
    if (actual !== code) {
      throw new Error(
        `Expected error code "${code}" but got "${String(actual)}" (${String(err)})`
      );
    }
    return;
  }
  throw new Error(`Expected error code "${code}" but the call succeeded`);
}
