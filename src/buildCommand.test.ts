import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCommand, assertValidVerbose, ConversionParams } from './buildCommand';

const base = (extra: Record<string, unknown> = {}): ConversionParams =>
    ({
        input: '/in.pdf',
        output: '/out.epub',
        delete: false,
        silent: true,
        calibrePath: '',
        ...extra,
    }) as ConversionParams;

test('uses ebook-convert from PATH when no calibrePath is set', () => {
    const { file, args } = buildCommand('/in.pdf', '/out.epub', base());
    assert.equal(file, 'ebook-convert');
    assert.deepEqual(args, ['/in.pdf', '/out.epub']);
});

test('prefixes the executable with an explicit calibrePath', () => {
    const { file } = buildCommand('/in.pdf', '/out.epub', base({ calibrePath: '/opt/calibre' }));
    assert.equal(file, '/opt/calibre/ebook-convert');
});

test('does not forward library-internal params as Calibre flags', () => {
    const { args } = buildCommand('/in.pdf', '/out.epub', base({ timeoutMs: 5000, delete: true }));
    assert.deepEqual(args, ['/in.pdf', '/out.epub']);
    assert.ok(!args.some(a => a.includes('timeoutMs')), 'timeoutMs is ours, not Calibre\'s');
    assert.ok(!args.some(a => a.includes('delete')));
});

test('renders key/value and boolean options', () => {
    const { args } = buildCommand(
        '/in.pdf',
        '/out.epub',
        base({ authors: 'Jane Doe', 'no-default-epub-cover': true })
    );
    assert.ok(args.includes('--authors=Jane Doe'));
    assert.ok(args.includes('--no-default-epub-cover'));
});

test('rejects option keys that could be misread as arguments', () => {
    for (const key of ['--sneaky', 'has space', '-leading-dash', 'semi;colon', '']) {
        assert.throws(
            () => buildCommand('/in.pdf', '/out.epub', base({ [key]: 'x' })),
            /Invalid conversion option key/,
            `key ${JSON.stringify(key)} should be rejected`
        );
    }
});

test('maps the verbose levels to the right number of --verbose flags', () => {
    const flags = (verbose: string) =>
        buildCommand('/in.pdf', '/out.epub', base({ verbose })).args.filter(
            a => a === '--verbose'
        );

    assert.equal(flags('low').length, 0, 'low is the default and adds no flag');
    assert.equal(flags('med').length, 1);
    assert.equal(flags('high').length, 2);
});

test('throws a clear error on an unrecognised verbose value instead of passing it through', () => {
    // Regression test: 'High' previously fell through to the generic
    // --key=value branch and was handed to Calibre as `--verbose=High`.
    for (const bad of ['High', 'medium', 'LOW', 'true', '', 'debug']) {
        assert.throws(
            () => buildCommand('/in.pdf', '/out.epub', base({ verbose: bad })),
            (err: unknown) => {
                assert.match((err as Error).message, /Invalid "verbose" value/);
                assert.match((err as Error).message, /low, med, high/);
                return true;
            },
            `verbose=${JSON.stringify(bad)} should fail fast`
        );
    }

    const { args } = buildCommand('/in.pdf', '/out.epub', base({ verbose: 'high' }));
    assert.ok(!args.some(a => a.startsWith('--verbose=')), 'never emits --verbose=<value>');
});

test('assertValidVerbose accepts exactly the documented levels', () => {
    for (const ok of ['low', 'med', 'high']) {
        assert.doesNotThrow(() => assertValidVerbose(ok));
    }
    for (const bad of [undefined, null, 1, true, 'High']) {
        assert.throws(() => assertValidVerbose(bad), /Invalid "verbose" value/);
    }
});
