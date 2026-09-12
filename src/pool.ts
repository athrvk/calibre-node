/**
 * A bounded work scheduler.
 *
 * This deliberately knows nothing about worker threads or Calibre: it owns only
 * the concurrency and backpressure policy. `index.ts` supplies a runner that
 * spawns a real `Worker`, while tests can supply a fake runner -- which is what
 * makes the "never exceed poolSize" invariant testable without spinning up OS
 * threads or requiring a Calibre installation.
 *
 * The important property, and the bug this fixes, is that a task is handed to
 * the runner *only* when a slot is free. Previously the `Worker` was constructed
 * eagerly in `convert()` and the pool gate merely delayed its `postMessage`, so
 * a burst of requests spawned an unbounded number of live OS threads no matter
 * what `poolSize` was set to.
 */

/**
 * Invoked when a task is dispatched. Must call `done()` exactly once, on every
 * terminal outcome (success *or* failure). The pool defends against extra calls,
 * but never calling it leaks a slot permanently.
 */
export type TaskRunner<T> = (task: T, done: () => void) => void;

export interface PoolLimits {
    /** Maximum number of tasks dispatched concurrently. */
    poolSize: () => number;
    /** Maximum number of tasks allowed to wait for a slot. */
    maxQueueSize: () => number;
}

export class WorkPool<T> {
    private pending: T[] = [];
    private active = 0;

    constructor(
        private readonly runner: TaskRunner<T>,
        private readonly limits: PoolLimits
    ) {}

    /** Number of tasks currently dispatched (i.e. live workers). */
    get activeCount(): number {
        return this.active;
    }

    /** Number of tasks waiting for a free slot. */
    get pendingCount(): number {
        return this.pending.length;
    }

    /**
     * Enqueues a task, dispatching it immediately if a slot is free.
     *
     * @returns `false` if the pending queue is already at `maxQueueSize`, in
     * which case the task is *not* accepted and the caller should apply
     * backpressure. This is what stops an unbounded queue from growing under
     * sustained overload.
     */
    trySubmit(task: T): boolean {
        if (this.pending.length >= this.limits.maxQueueSize()) return false;
        this.pending.push(task);
        this.pump();
        return true;
    }

    private pump(): void {
        while (this.active < this.limits.poolSize() && this.pending.length > 0) {
            const task = this.pending.shift() as T;
            this.active++;

            let settled = false;
            const done = () => {
                // Guarded because a worker can plausibly emit both an 'error'
                // and an 'exit' event for the same failure; double-counting
                // would corrupt the active count and over-admit work.
                if (settled) return;
                settled = true;
                this.active--;
                this.pump();
            };

            try {
                this.runner(task, done);
            } catch (err) {
                // Runners are expected to report failures through `done()` and
                // not throw. If one throws anyway (e.g. `new Worker` failing
                // because the script is missing), free the slot and keep
                // draining: rethrowing here would strand every other queued
                // task. The error is logged rather than swallowed.
                console.error(
                    '[calibre-node][thread-main] Task runner threw synchronously:',
                    err
                );
                done();
            }
        }
    }
}
