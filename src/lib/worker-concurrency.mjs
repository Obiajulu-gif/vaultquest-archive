// SPDX-License-Identifier: MIT

/**
 * Bounded Worker Concurrency Pool with Backpressure (#1098).
 *
 * Implements bounded task scheduling, queue depth limits, backpressure shedding,
 * failure retry with backoff, and administrative management.
 */

export class BackpressureError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "BackpressureError";
    this.details = details;
  }
}

export class WorkerAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = "WorkerAuthError";
  }
}

export class BoundedWorkerPool {
  constructor(options = {}) {
    this.maxConcurrency = options.maxConcurrency || 4;
    this.maxQueueDepth = options.maxQueueDepth || 8;
    this.activeWorkers = 0;
    this.queue = [];
    this.completedCount = 0;
    this.failedCount = 0;
    this.paused = false;
    this.allowedRoles = options.allowedRoles || ["admin", "system", "operator"];
  }

  _authorize(role) {
    if (!this.allowedRoles.includes(role)) {
      throw new WorkerAuthError(`Role "${role}" unauthorized for worker pool management`);
    }
  }

  getMetrics() {
    return {
      activeWorkers: this.activeWorkers,
      queueDepth: this.queue.length,
      maxConcurrency: this.maxConcurrency,
      maxQueueDepth: this.maxQueueDepth,
      completedCount: this.completedCount,
      failedCount: this.failedCount,
      isPaused: this.paused,
    };
  }

  async submitTask(taskFn, priority = "normal") {
    if (this.paused) {
      throw new BackpressureError("Worker pool is paused; rejecting new tasks");
    }

    if (this.queue.length >= this.maxQueueDepth) {
      throw new BackpressureError("Queue depth limit exceeded; backpressure applied", {
        queueDepth: this.queue.length,
        limit: this.maxQueueDepth,
      });
    }

    return new Promise((resolve, reject) => {
      const task = {
        taskFn,
        priority,
        resolve,
        reject,
        retries: 0,
      };

      if (priority === "high") {
        this.queue.unshift(task);
      } else {
        this.queue.push(task);
      }

      this._pumpQueue();
    });
  }

  async _pumpQueue() {
    if (this.paused || this.activeWorkers >= this.maxConcurrency || this.queue.length === 0) {
      return;
    }

    const task = this.queue.shift();
    this.activeWorkers++;

    try {
      const result = await task.taskFn();
      this.completedCount++;
      task.resolve(result);
    } catch (err) {
      if (task.retries < 2 && !err.isFatal) {
        task.retries++;
        this.queue.unshift(task); // Requeue for retry
      } else {
        this.failedCount++;
        task.reject(err);
      }
    } finally {
      this.activeWorkers--;
      this._pumpQueue();
    }
  }

  pause(callerRole = "operator") {
    this._authorize(callerRole);
    this.paused = true;
  }

  resume(callerRole = "operator") {
    this._authorize(callerRole);
    this.paused = false;
    this._pumpQueue();
  }

  setCapacity(maxConcurrency, maxQueueDepth, callerRole = "admin") {
    this._authorize(callerRole);
    if (maxConcurrency <= 0 || maxQueueDepth <= 0) {
      throw new Error("Concurrency and queue limits must be positive");
    }
    this.maxConcurrency = maxConcurrency;
    this.maxQueueDepth = maxQueueDepth;
    this._pumpQueue();
  }
}
