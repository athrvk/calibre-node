import test from 'node:test';
import assert from 'node:assert/strict';
import execPromise, { ExecError, DEFAULT_TIMEOUT_MS } from './execPromise';

/**
 * These tests deliberately shell out to `process.execPath` (the Node binary
 * already running the tests) rather than to Calibre, so they exercise the real
 * `execFile` timeout/signal plumbing without requiring a Calibre installation.
 */
const node = process.execPath;

test('resolves with both stdout and stderr on success', async () => {
    const { stdout, stderr } = await execPromise(node, [
        '-e',
        'process.stdout.write("out-data"); process.stderr.write("err-data");',
    ]);

    assert.equal(stdout, 'out-data');
    assert.equal(stderr, 'err-data', 'stderr must be captured, not discarded');
});

test('rejects with stderr, exit code and stdout on non-zero exit', async () => {
    await assert.rejects(
        () =>
            execPromise(node, [
                '-e',
                'process.stdout.write("partial"); process.stderr.write("calibre says no"); process.exit(3);',
            ]),
        (err: unknown) => {
            assert.ok(err instanceof ExecError, 'should reject with an ExecError');
            assert.equal(err.code, 3);
            assert.equal(err.stderr, 'calibre says no');
            assert.equal(err.stdout, 'partial');
            assert.equal(err.timedOut, false, 'a normal failure is not a timeout');
            assert.equal(err.killed, false);
            assert.ok(err.stack, 'a real Error carries a stack');
            return true;
        }
    );
});

test('kills a hanging process once the timeout elapses and reports timedOut', async () => {
    const started = Date.now();

    await assert.rejects(
        // A process that never exits on its own; only the timeout can end it.
        () => execPromise(node, ['-e', 'setInterval(() => {}, 1000);'], { timeoutMs: 300 }),
        (err: unknown) => {
            assert.ok(err instanceof ExecError);
            assert.equal(err.timedOut, true, 'timeout must be distinguishable from a normal failure');
            assert.equal(err.killed, true);
            assert.equal(err.signal, 'SIGKILL');
            assert.equal(err.timeoutMs, 300);
            assert.match(err.message, /timed out after 300ms/);
            return true;
        }
    );

    // Guards against the timeout being silently ignored: without it this
    // process would hang forever rather than finishing promptly.
    assert.ok(Date.now() - started < 15_000, 'should have been killed near the timeout');
});

test('a process that finishes inside its timeout is not reported as timed out', async () => {
    const { stdout } = await execPromise(node, ['-e', 'process.stdout.write("quick")'], {
        timeoutMs: 10_000,
    });
    assert.equal(stdout, 'quick');
});

test('rejects with a spawn error code when the executable does not exist', async () => {
    await assert.rejects(
        () => execPromise('definitely-not-a-real-binary-xyz', ['--version']),
        (err: unknown) => {
            assert.ok(err instanceof ExecError);
            assert.equal(err.code, 'ENOENT');
            assert.equal(err.timedOut, false);
            return true;
        }
    );
});

test('falls back to the default timeout for absent or non-positive overrides', async () => {
    for (const timeoutMs of [undefined, 0, -1]) {
        await assert.rejects(
            () => execPromise(node, ['-e', 'process.exit(1)'], { timeoutMs }),
            (err: unknown) => {
                assert.ok(err instanceof ExecError);
                assert.equal(err.timeoutMs, DEFAULT_TIMEOUT_MS);
                return true;
            }
        );
    }
});
