/**
 * Pure command-construction logic for `ebook-convert`.
 *
 * Kept in its own module (rather than inside `converter.ts`) because
 * `converter.ts` is a worker entry point that throws on import when it is not
 * running inside a worker thread, which makes it impossible to unit test.
 */

export interface ConversionParams {
    input: string;
    output: string;
    delete: boolean;
    silent: boolean;
    calibrePath: string;
    [key: string]: string | boolean | number | undefined;
}

export interface Command {
    file: string;
    args: string[];
}

/** Option keys consumed by this library rather than forwarded to Calibre. */
export const NON_FLAG_PARAMS = [
    'input',
    'output',
    'delete',
    'silent',
    'calibrePath',
    'timeoutMs',
];

// Calibre option keys are simple flag names; reject anything that could be
// misinterpreted as an argument or otherwise be unexpected. This is
// defence-in-depth: execFile already prevents shell injection.
export const OPTION_KEY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9-]*$/;

/** The only verbosity levels this library understands. */
export const VERBOSE_LEVELS = ['low', 'med', 'high'] as const;
export type VerboseLevel = (typeof VERBOSE_LEVELS)[number];

/**
 * Validates a `verbose` value, throwing a clear error for anything unrecognised.
 *
 * Previously an unrecognised value (a typo such as `'High'`) fell through to the
 * generic `--key=value` branch and was handed to Calibre as `--verbose=High`,
 * which Calibre rejects with a confusing message. Failing fast here attributes
 * the mistake to the caller instead.
 */
export const assertValidVerbose = (value: unknown): void => {
    if (!VERBOSE_LEVELS.includes(value as VerboseLevel)) {
        throw new Error(
            `Invalid "verbose" value: ${JSON.stringify(value)}. ` +
                `Expected one of: ${VERBOSE_LEVELS.join(', ')}.`
        );
    }
};

export const buildCommand = (
    inputPath: string,
    outputPath: string,
    params: ConversionParams
): Command => {
    const calibrePath = params.calibrePath === '' ? '' : params.calibrePath + '/';
    const file = calibrePath + 'ebook-convert';
    const args: string[] = [inputPath, outputPath];

    Object.keys(params).forEach(key => {
        if (NON_FLAG_PARAMS.includes(key)) return;
        if (!OPTION_KEY_PATTERN.test(key)) {
            throw new Error(`Invalid conversion option key: "${key}"`);
        }

        if (key === 'verbose') {
            assertValidVerbose(params[key]);
            if (params[key] === 'med') args.push('--verbose');
            else if (params[key] === 'high') args.push('--verbose', '--verbose');
            // 'low' is the default and adds no flag.
            return;
        }

        if (params[key] !== undefined && [true, 'true'].includes(params[key] as string | boolean)) {
            args.push(`--${key}`);
        } else {
            args.push(`--${key}=${params[key]}`);
        }
    });

    return { file, args };
};
