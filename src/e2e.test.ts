import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * End-to-end tests against the *built* library, driving a fake `ebook-convert`
 * so the full main-thread -> worker -> child-process pipeline is exercised
 * without requiring a real Calibre installation.
 *
 * These cover the pieces that cannot be unit tested in isolation: that a hung
 * conversion is actually killed and reported as `timedOut`, that Calibre's
 * stderr survives the worker boundary, and that a partially-written output file
 * is cleaned up on failure.
 */

const distIndex = path.join(__dirname, '..', 'dist', 'index.js');
const distConverter = path.join(__dirname, '..', 'dist', 'converter.js');
const built = fs.existsSync(distIndex) && fs.existsSync(distConverter);

// `npm test` builds first; when running the TS tests directly without a build,
// skip rather than fail misleadingly.
const describeOpts = built
    ? {}
    : { skip: 'dist/ not built -- run `npm run build` (or `npm test`) first' };

const FAKE = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--version') { process.stdout.write('fake ebook-convert 1.0\\n'); process.exit(0); }
const [input, output] = args;
const fs = require('fs');
if (input.includes('hang')) {
    // Never exits on its own: only the timeout can end this.
    fs.writeFileSync(output, 'PARTIAL');
    setInterval(() => {}, 1000);
} else if (input.includes('fail')) {
    // Write a truncated artefact, then fail the way Calibre does.
    fs.writeFileSync(output, 'PARTIAL');
    process.stderr.write('calibre: Failed to parse input document\\n');
    process.exit(1);
} else {
    process.stdout.write('Converting...\\n');
    fs.writeFileSync(output, 'EPUB-CONTENT');
    process.exit(0);
}
`;

let tmp: string;
let calibreDir: string;

const setup = () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'calibre-node-e2e-'));
    calibreDir = path.join(tmp, 'bin');
    fs.mkdirSync(calibreDir);
    const fake = path.join(calibreDir, 'ebook-convert');
    fs.writeFileSync(fake, FAKE);
    fs.chmodSync(fake, 0o755);
};

const makeInput = (name: string) => {
    const p = path.join(tmp, name);
    fs.writeFileSync(p, 'input-bytes');
    return p;
};

test('end-to-end against a fake ebook-convert', describeOpts, async t => {
    setup();

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const lib = require(distIndex);
    lib.setCalibrePath(calibreDir);
    lib.setPoolSize(2);

    await t.test('resolves with the documented success shape', async () => {
        const input = makeInput('good.pdf');
        const output = path.join(tmp, 'good.epub');

        const result = await lib.convert({ input, output, delete: false, silent: true });

        // The exact shape existing consumers depend on.
        assert.deepEqual(result, {
            success: true,
            filePath: output,
            filename: 'good.epub',
            extension: 'epub',
        });
        assert.equal(fs.readFileSync(output, 'utf8'), 'EPUB-CONTENT');
        assert.ok(fs.existsSync(input), 'input is kept when delete is false');
    });

    await t.test('deletes the input file when delete is true', async () => {
        const input = makeInput('todelete.pdf');
        const output = path.join(tmp, 'todelete.epub');

        await lib.convert({ input, output, delete: true, silent: true });

        assert.equal(fs.existsSync(input), false, 'input should be removed');
        assert.ok(fs.existsSync(output));
    });

    await t.test('propagates stderr and the exit code, and cleans up partial output', async () => {
        const input = makeInput('fail.pdf');
        const output = path.join(tmp, 'fail.epub');

        const err = await lib
            .convert({ input, output, delete: false, silent: true })
            .then(() => null, (e: any) => e);

        assert.ok(err, 'a failing conversion must reject');
        // Legacy reject shape preserved.
        assert.equal(err.success, false);
        assert.equal(err.outputPath, output);
        assert.equal(typeof err.error, 'string');
        // Added detail: the actual diagnostic finally reaches the caller.
        assert.match(err.stderr, /Failed to parse input document/);
        assert.equal(err.code, 1);
        assert.equal(err.timedOut, false, 'a rejected file is not a timeout');

        assert.equal(
            fs.existsSync(output),
            false,
            'the truncated output file must not be left on disk'
        );
    });

    await t.test('kills a hung conversion, reports timedOut, and removes the partial file', async () => {
        const input = makeInput('hang.pdf');
        const output = path.join(tmp, 'hang.epub');

        const started = Date.now();
        const err = await lib
            .convert({ input, output, delete: false, silent: true, timeoutMs: 700 })
            .then(() => null, (e: any) => e);

        assert.ok(err, 'a hung conversion must reject rather than hang forever');
        assert.equal(err.success, false);
        assert.equal(err.timedOut, true, 'must be distinguishable from a normal failure');
        assert.equal(err.killed, true);
        assert.equal(err.signal, 'SIGKILL');
        assert.ok(Date.now() - started < 20_000, 'should reject near the timeout');
        assert.equal(fs.existsSync(output), false, 'partial output removed after timeout');
    });

    await t.test('a hung conversion does not permanently consume a pool slot', async () => {
        // The original bug: with poolSize 2, two hung files wedged every future
        // conversion forever. Saturate the pool with hangs, then prove a normal
        // conversion still succeeds afterwards.
        lib.setPoolSize(2);

        const hangs = ['hang1.pdf', 'hang2.pdf', 'hang3.pdf'].map(name => {
            const input = makeInput(name);
            return lib
                .convert({
                    input,
                    output: path.join(tmp, name.replace('.pdf', '.epub')),
                    delete: false,
                    silent: true,
                    timeoutMs: 700,
                })
                .then(() => null, (e: any) => e);
        });

        const results = await Promise.all(hangs);
        for (const err of results) {
            assert.ok(err, 'each hung conversion rejects');
            assert.equal(err.timedOut, true);
        }

        assert.equal(lib.getPendingCount(), 0, 'queue drained');

        const input = makeInput('after.pdf');
        const output = path.join(tmp, 'after.epub');
        const ok = await lib.convert({ input, output, delete: false, silent: true });
        assert.equal(ok.success, true, 'the pool still works after repeated hangs');
    });

    await t.test('reports a clear error when Calibre is missing', async () => {
        lib.setCalibrePath(path.join(tmp, 'does-not-exist'));

        const err = await lib
            .convert({
                input: makeInput('good2.pdf'),
                output: path.join(tmp, 'good2.epub'),
                delete: false,
                silent: true,
            })
            .then(() => null, (e: any) => e);

        assert.ok(err);
        assert.equal(err.success, false);
        assert.match(err.error, /Calibre executable not found|not installed/);

        lib.setCalibrePath(calibreDir);
    });
});
