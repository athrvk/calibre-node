import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkPool } from './pool';

/**
 * The pool is tested with a fake runner instead of real worker threads. That is
 * the whole point of the refactor: the "never exceed poolSize" invariant is now
 * checkable without spawning OS threads or requiring Calibre to be installed.
 */
interface Task {
    id: number;
}

const makePool = (poolSize: number, maxQueueSize = Infinity) => {
    const dispatched: number[] = [];
    const finishers = new Map<number, () => void>();
    let concurrent = 0;
    let peakConcurrent = 0;

    const pool = new WorkPool<Task>(
        (task, done) => {
            dispatched.push(task.id);
            concurrent++;
            peakConcurrent = Math.max(peakConcurrent, concurrent);
            finishers.set(task.id, () => {
                concurrent--;
                done();
            });
        },
        { poolSize: () => poolSize, maxQueueSize: () => maxQueueSize }
    );

    const finish = (id: number) => {
        const f = finishers.get(id);
        assert.ok(f, `task ${id} was never dispatched`);
        finishers.delete(id);
        f();
    };

    return { pool, dispatched, finish, peak: () => peakConcurrent };
};

test('dispatches no more tasks than poolSize, holding the rest as pending requests', () => {
    const { pool, dispatched } = makePool(2);

    for (let id = 0; id < 10; id++) {
        assert.equal(pool.trySubmit({ id }), true);
    }

    // This is the core regression: previously a Worker was constructed for
    // every request up front, so a burst of 10 spawned 10 live threads even
    // with poolSize 2. Now only 2 are ever handed to the runner.
    assert.deepEqual(dispatched, [0, 1], 'only poolSize tasks may be dispatched');
    assert.equal(pool.activeCount, 2);
    assert.equal(pool.pendingCount, 8, 'the remainder wait as requests, not as workers');
});

test('dispatches a queued task only as each slot is freed, and never exceeds the peak', () => {
    const { pool, dispatched, finish, peak } = makePool(2);

    for (let id = 0; id < 6; id++) pool.trySubmit({ id });
    assert.deepEqual(dispatched, [0, 1]);

    finish(0);
    assert.deepEqual(dispatched, [0, 1, 2], 'freeing one slot admits exactly one task');
    finish(1);
    finish(2);
    assert.deepEqual(dispatched, [0, 1, 2, 3, 4]);

    finish(3);
    finish(4);
    assert.deepEqual(dispatched, [0, 1, 2, 3, 4, 5]);
    finish(5);

    assert.equal(peak(), 2, 'concurrency never exceeded poolSize at any point');
    assert.equal(pool.activeCount, 0, 'every slot is reclaimed');
    assert.equal(pool.pendingCount, 0);
});

test('tasks are dispatched in FIFO order', () => {
    const { pool, dispatched, finish } = makePool(1);
    for (let id = 0; id < 4; id++) pool.trySubmit({ id });
    for (let id = 0; id < 4; id++) finish(id);
    assert.deepEqual(dispatched, [0, 1, 2, 3]);
});

test('refuses submissions once maxQueueSize pending requests are waiting', () => {
    const { pool, finish } = makePool(1, 2);

    assert.equal(pool.trySubmit({ id: 0 }), true, 'dispatched immediately');
    assert.equal(pool.trySubmit({ id: 1 }), true, 'pending 1');
    assert.equal(pool.trySubmit({ id: 2 }), true, 'pending 2');
    assert.equal(pool.pendingCount, 2);

    // Backpressure: the queue must not grow without bound under burst load.
    assert.equal(pool.trySubmit({ id: 3 }), false);
    assert.equal(pool.trySubmit({ id: 4 }), false);
    assert.equal(pool.pendingCount, 2, 'refused tasks are not queued');

    // Draining a slot makes room again.
    finish(0);
    assert.equal(pool.pendingCount, 1);
    assert.equal(pool.trySubmit({ id: 5 }), true);
});

test('a slot is freed even when the task fails, so failures cannot wedge the pool', () => {
    const dispatched: number[] = [];
    const pool = new WorkPool<Task>(
        (task, done) => {
            dispatched.push(task.id);
            // Simulate the failure path calling done() without any success.
            done();
        },
        { poolSize: () => 1, maxQueueSize: () => Infinity }
    );

    for (let id = 0; id < 5; id++) pool.trySubmit({ id });

    assert.deepEqual(dispatched, [0, 1, 2, 3, 4], 'all tasks ran despite every one failing');
    assert.equal(pool.activeCount, 0);
});

test('a double done() call cannot corrupt the active count or over-admit work', () => {
    const dispatched: number[] = [];
    const dones: Array<() => void> = [];
    const pool = new WorkPool<Task>(
        (task, done) => {
            dispatched.push(task.id);
            dones.push(done);
        },
        { poolSize: () => 1, maxQueueSize: () => Infinity }
    );

    pool.trySubmit({ id: 0 });
    pool.trySubmit({ id: 1 });
    assert.deepEqual(dispatched, [0]);

    // A worker can plausibly emit both 'error' and 'exit' for one failure.
    const done0 = dones[0];
    done0();
    done0();
    done0();

    assert.equal(pool.activeCount, 1, 'exactly one task is active, not a negative count');
    assert.deepEqual(dispatched, [0, 1], 'the extra done() calls did not admit extra work');
});

test('a runner that throws synchronously frees its slot and does not strand the queue', () => {
    const seen: number[] = [];
    const pool = new WorkPool<Task>(
        task => {
            seen.push(task.id);
            throw new Error('spawn failed');
        },
        { poolSize: () => 1, maxQueueSize: () => Infinity }
    );

    for (let id = 0; id < 3; id++) pool.trySubmit({ id });

    assert.deepEqual(seen, [0, 1, 2], 'later tasks still get their turn');
    assert.equal(pool.activeCount, 0);
    assert.equal(pool.pendingCount, 0);
});

test('poolSize is read dynamically, so setPoolSize takes effect on the next drain', () => {
    let size = 1;
    const dispatched: number[] = [];
    const dones: Array<() => void> = [];
    const pool = new WorkPool<Task>(
        (task, done) => {
            dispatched.push(task.id);
            dones.push(done);
        },
        { poolSize: () => size, maxQueueSize: () => Infinity }
    );

    for (let id = 0; id < 4; id++) pool.trySubmit({ id });
    assert.deepEqual(dispatched, [0]);

    size = 3;
    dones[0]();

    assert.deepEqual(dispatched, [0, 1, 2, 3], 'the larger pool drains the backlog');
});
