import fs from 'fs';
import { parentPort, workerData, threadId } from 'worker_threads';
import execPromise, { ExecError } from './execPromise';
import { buildCommand, ConversionParams } from './buildCommand';
import { ERROR_MARKER, WorkerFailurePayload } from './messages';
import { performance } from 'perf_hooks';

export type { ConversionParams } from './buildCommand';
export { ERROR_MARKER } from './messages';
export type { WorkerFailurePayload } from './messages';

if (!parentPort) throw new Error('This script must be run as a worker thread!');

const logPrefix = `[calibre-node][thread-${threadId}] `;

const getConversionParams = (): ConversionParams => {
    return workerData as ConversionParams;
};

const toFailurePayload = (err: unknown): WorkerFailurePayload => {
    if (err instanceof ExecError) {
        return {
            [ERROR_MARKER]: true,
            error: err.message,
            stack: err.stack,
            stdout: err.stdout,
            stderr: err.stderr,
            code: err.code,
            signal: err.signal,
            killed: err.killed,
            timedOut: err.timedOut,
        };
    }
    const asError = err as Error;
    return {
        [ERROR_MARKER]: true,
        error: asError?.message ?? String(err),
        stack: asError?.stack,
    };
};

/**
 * Removes a partially-written output file after a failed conversion.
 *
 * A conversion that fails or is killed mid-write leaves a truncated artefact on
 * disk, which previously stayed there indefinitely. `existedBefore` guards
 * against destroying a pre-existing file at the same path that this run never
 * actually wrote to.
 */
const cleanupFailedOutput = async (
    outputPath: string,
    existedBefore: boolean,
    log: (m: string) => void
): Promise<void> => {
    if (existedBefore) return;
    try {
        if (!outputPath || !fs.existsSync(outputPath)) return;
        await fs.promises.unlink(outputPath);
        log(`Removed partial output file ${outputPath}`);
    } catch (err) {
        // Best effort only -- never let cleanup mask the original failure.
        console.warn(
            `${logPrefix}Failed to remove partial output file ${outputPath}: ${(err as Error).message}`
        );
    }
};

const handleConversion = async (params: ConversionParams, value: any) => {
    const inputPath = params.input;
    const outputPath = params.output;
    const port = value?.port;

    const log = (message: string) => {
        if (!params.silent) {
            console.log(`${logPrefix}${message}`);
        }
    };

    // Recorded before the conversion runs so cleanup can distinguish "we wrote
    // a partial file" from "a file was already sitting at this path".
    const outputExistedBefore = outputPath ? fs.existsSync(outputPath) : false;

    try {
        if (!inputPath || !fs.existsSync(inputPath)) {
            throw new Error(`Input path ${inputPath} not found!`);
        }

        const startTime = performance.now();
        const { file, args } = buildCommand(inputPath, outputPath, params);
        const timeoutMs =
            typeof params.timeoutMs === 'number' ? params.timeoutMs : undefined;

        log(`Starting conversion:`);
        log([file, ...args].join(' '));

        const { stdout, stderr } = await execPromise(file, args, { timeoutMs });

        if (params.verbose && params.verbose !== 'low') {
            stdout.split('\n').forEach(_log => console.log('[calibre] ' + _log));
            if (stderr.trim()) {
                stderr.split('\n').forEach(_log => console.log('[calibre][stderr] ' + _log));
            }
        }

        const duration = performance.now() - startTime;
        log(`Conversion completed in ${duration.toFixed(3)} ms`);

        if (params.delete) {
            // Done *before* reporting success so that a caller awaiting
            // convert() can rely on the input having actually been removed by
            // the time the promise resolves. Reporting first left the unlink
            // racing the caller, which could observe the input still present.
            //
            // Best effort: a failure to delete the input must not fail an
            // otherwise successful conversion, so it is logged rather than
            // thrown. Throwing from inside the old `fs.unlink` callback became
            // an uncaught exception in the worker with no channel left to
            // report it on, silently killing the worker after the fact.
            try {
                await fs.promises.unlink(inputPath);
                log(`Deleted input file ${inputPath}`);
            } catch (err) {
                console.warn(
                    `${logPrefix}Failed to delete input file ${inputPath}: ${(err as Error).message}`
                );
            }
        }

        port?.postMessage({ ...params });
        port?.close();
    } catch (err) {
        const payload = toFailurePayload(err);
        log(`Conversion failed: ${payload.error}`);

        await cleanupFailedOutput(outputPath, outputExistedBefore, log);

        // Report the structured failure, then let the worker exit cleanly (code
        // 0). The main thread distinguishes success from failure by the payload
        // marker, not by the exit code.
        try {
            port?.postMessage(payload);
            port?.close();
        } catch {
            // Channel already gone; the main thread will observe the exit.
            console.error(`${logPrefix}${payload.error}`);
        }
    }
};

const checkCalibre = async (calibrePath: string): Promise<void> => {
    const prefix = calibrePath === '' ? '' : calibrePath + '/';
    try {
        await execPromise(prefix + 'ebook-convert', ['--version']);
    } catch (err) {
        const message = (err as Error).message;
        if (message.includes('not found') || message.includes('ENOENT')) {
            throw new Error(
                `Calibre executable not found in ${
                    calibrePath === '' ? 'system PATH' : `specified path: ${calibrePath}`
                }. Calibre is not installed. Please install it from https://calibre-ebook.com/download`,
                // Keep the underlying spawn failure (e.g. the ENOENT) attached
                // rather than discarding it behind the friendlier message.
                { cause: err }
            );
        }
        throw err;
    }
};

parentPort.once('message', async (value) => {
    const params = getConversionParams();
    try {
        await checkCalibre(params.calibrePath);
    } catch (err) {
        // Surface a missing/broken Calibre through the same structured channel
        // as any other failure instead of exiting non-zero with the detail only
        // on the worker's stderr.
        const payload = toFailurePayload(err);
        console.error(logPrefix + payload.error);
        try {
            value?.port?.postMessage(payload);
            value?.port?.close();
        } catch {
            process.exit(1);
        }
        return;
    }
    await handleConversion(params, value);
});
