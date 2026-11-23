// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import {
  BoundedWorkerPool,
  BackpressureError,
  WorkerAuthError,
} from "../../src/lib/worker-concurrency.mjs";

test("bounded worker concurrency with backpressure (#1098)", async (t) => {
  await t.test("normal path: executes tasks within concurrency bounds and prioritizes queue", async () => {
    const pool = new BoundedWorkerPool({ maxConcurrency: 2, maxQueueDepth: 5 });

    let running = 0;
    let maxObserved = 0;

    const makeTask = (id, ms = 20) => async () => {
      running++;
      if (running > maxObserved) maxObserved = running;
      await new Promise((r) => setTimeout(r, ms));
      running--;
      return id;
    };

    const results = await Promise.all([
      pool.submitTask(makeTask("t1")),
      pool.submitTask(makeTask("t2")),
      pool.submitTask(makeTask("t3")),
    ]);

    assert.deepEqual(results, ["t1", "t2", "t3"]);
    assert(maxObserved <= 2, `Expected max concurrency <= 2, observed ${maxObserved}`);
    assert.equal(pool.getMetrics().completedCount, 3);
  });

  await t.test("failure path: throws BackpressureError when queue depth limit is exceeded", async () => {
    const pool = new BoundedWorkerPool({ maxConcurrency: 1, maxQueueDepth: 1 });

    const slowTask = () => new Promise((r) => setTimeout(r, 100));
    pool.submitTask(slowTask); // active
    pool.submitTask(slowTask); // queued (depth = 1)

    // Third task must be shed with backpressure
    await assert.rejects(
      async () => pool.submitTask(slowTask),
      (err) => err instanceof BackpressureError && err.message.includes("limit exceeded")
    );
  });

  await t.test("retry & recovery path: automatically retries transient task errors before permanent failure", async () => {
    const pool = new BoundedWorkerPool({ maxConcurrency: 2, maxQueueDepth: 5 });

    let attempts = 0;
    const transientTask = async () => {
      attempts++;
      if (attempts < 2) {
        throw new Error("Temporary network glitch");
      }
      return "recovered";
    };

    const res = await pool.submitTask(transientTask);
    assert.equal(res, "recovered");
    assert.equal(attempts, 2);
  });

  await t.test("authorization path: only authorized operators can pause, resume, or adjust capacity", async () => {
    const pool = new BoundedWorkerPool();

    assert.throws(() => pool.pause("guest"), (err) => err instanceof WorkerAuthError);
    assert.throws(() => pool.resume("guest"), (err) => err instanceof WorkerAuthError);
    assert.throws(() => pool.setCapacity(10, 20, "viewer"), (err) => err instanceof WorkerAuthError);

    pool.pause("operator");
    assert.equal(pool.getMetrics().isPaused, true);
    pool.resume("operator");
    assert.equal(pool.getMetrics().isPaused, false);
  });
});
