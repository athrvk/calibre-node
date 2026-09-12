import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import os from 'os';
import {
    convert,
    ConversionError,
    setPoolSize,
    setMaxQueueSize,
    getPoolSize,
    getMaxQueueSize,
    getPendingCount,
    DEFAULT_MAX_QUEUE_SIZE,
} from './index';

const out = (name: string) => path.join(os.tmpdir(), name);

test('ConversionError keeps the legacy reject shape while adding detail', () => {
    const err = new ConversionError('/tmp/out.epub', 'boom', {
        stderr: 'calibre stderr',
        code: 1,
        signal: 'SIGKILL',
        killed: true,
        timedOut: true,
    });

    // Backward compatibility: consumers destructure exactly these three.
    assert.equal(err.success, false);
    assert.equal(err.outputPath, '/tmp/out.epub');
    assert.equal(err.error, 'boom');
    assert.equal(typeof err.error, 'string', '.error must stay a plain string');

    // Additive detail, plus a real stack trace.
    assert.ok(err instanceof Error);
    assert.equal(err.message, 'boom');
    assert.ok(err.stack);
    assert.equal(err.stderr, 'calibre stderr');
    assert.equal(err.timedOut, true);
    assert.equal(err.killed, true);

    // The added fields are own/enumerable so JSON.stringify still carries them.
    const serialized = JSON.parse(JSON.stringify(err));
    assert.equal(serialized.success, false);
    assert.equal(serialized.error, 'boom');
    assert.equal(serialized.stderr, 'calibre stderr');
});

test('rejects an unrecognised verbose value before spawning any worker', async () => {
    const before = getPendingCount();

    await assert.rejects(
        () =>
            convert({
                input: './nope.pdf',
                output: out('a.epub'),
                delete: false,
                silent: true,
                // Deliberately invalid: a typo that used to reach Calibre.
                verbose: 'High' as never,
            }),
        (err: unknown) => {
            assert.ok(err instanceof ConversionError);
            assert.match(err.error, /Invalid "verbose" value/);
            assert.equal(err.success, false);
            return true;
        }
    );

    assert.equal(getPendingCount(), before, 'nothing was queued for an invalid request');
});

test('rejects a non-positive timeoutMs', async () => {
    for (const timeoutMs of [0, -5]) {
        await assert.rejects(
            () =>
                convert({
                    input: './nope.pdf',
                    output: out('b.epub'),
                    delete: false,
                    silent: true,
                    timeoutMs,
                }),
            (err: unknown) => {
                assert.ok(err instanceof ConversionError);
                assert.match(err.error, /Invalid "timeoutMs" value/);
                return true;
            }
        );
    }
});

test('applies backpressure with queueFull once maxQueueSize is reached', async () => {
    const originalPool = getPoolSize();
    const originalQueue = getMaxQueueSize();

    setPoolSize(1);
    setMaxQueueSize(1);

    try {
        // All three submissions happen in this same synchronous tick (convert's
        // promise executor runs synchronously), so the outcome is deterministic
        // and does not race the workers' async failures:
        //   #1 -> takes the single slot, #2 -> fills the queue, #3 -> refused.
        const settled = [
            convert({ input: './nope.pdf', output: out('q1.epub'), delete: false, silent: true }),
            convert({ input: './nope.pdf', output: out('q2.epub'), delete: false, silent: true }),
            convert({ input: './nope.pdf', output: out('q3.epub'), delete: false, silent: true }),
        ].map(p => p.catch((e: unknown) => e));

        const third = await settled[2];
        assert.ok(third instanceof ConversionError);
        assert.equal(third.queueFull, true, 'the over-limit request is refused, not queued');
        assert.match(third.error, /queue is full/);
        assert.equal(third.success, false);

        // The first two still fail (there is no built converter.js or Calibre
        // here), but they must fail as proper ConversionErrors -- which also
        // proves the pool frees slots on the failure path.
        for (const index of [0, 1]) {
            const err = await settled[index];
            assert.ok(err instanceof ConversionError, `request ${index} should reject cleanly`);
            assert.equal(err.queueFull, undefined);
            assert.equal(typeof err.error, 'string');
        }

        assert.equal(getPendingCount(), 0, 'the queue drained; no slot was leaked');
    } finally {
        setPoolSize(originalPool);
        setMaxQueueSize(originalQueue);
    }
});

test('pool and queue setters clamp invalid values and expose their state', () => {
    const originalPool = getPoolSize();
    const originalQueue = getMaxQueueSize();

    try {
        assert.equal(DEFAULT_MAX_QUEUE_SIZE, 100);

        setPoolSize(0);
        assert.equal(getPoolSize(), 1, 'pool size below 1 is clamped to 1');
        setPoolSize(4);
        assert.equal(getPoolSize(), 4);

        setMaxQueueSize(0);
        assert.equal(getMaxQueueSize(), 1, 'queue size below 1 is clamped to 1');
        setMaxQueueSize(Infinity);
        assert.equal(getMaxQueueSize(), Infinity, 'Infinity restores unbounded queueing');
        setMaxQueueSize(50);
        assert.equal(getMaxQueueSize(), 50);
    } finally {
        setPoolSize(originalPool);
        setMaxQueueSize(originalQueue);
    }
});
