import { MessagePort, Worker, isMainThread, MessageChannel } from 'worker_threads';
import path from 'path';
import { WorkPool } from './pool';
import { assertValidVerbose } from './buildCommand';
import { DEFAULT_TIMEOUT_MS } from './execPromise';
import { ERROR_MARKER, WorkerFailurePayload } from './messages';

let poolSize = 2;
let calibrePath: string = '';

/**
 * Default ceiling on conversions waiting for a free pool slot.
 *
 * Rationale: with the default `poolSize` of 2 and a realistic per-document
 * conversion time of a few seconds to tens of seconds, 100 queued requests is
 * already tens of minutes of backlog -- far longer than any sensible HTTP
 * request will wait. So this is a safety valve against unbounded memory growth
 * under burst load, not a throughput knob; it should essentially never be hit
 * by healthy traffic. Tune with {@link setMaxQueueSize}.
 */
export const DEFAULT_MAX_QUEUE_SIZE = 100;
let maxQueueSize: number = DEFAULT_MAX_QUEUE_SIZE;

/**
 * Extra time, beyond the conversion's own timeout, that the main thread waits
 * for a worker to report back before force-terminating it.
 *
 * The child process is already bounded by `timeoutMs`, so this only covers the
 * worker *thread* itself becoming stuck (or dying without emitting an event).
 * 30s is generous enough never to fire spuriously while still guaranteeing a
 * pool slot is reclaimed in bounded time.
 */
const WATCHDOG_GRACE_MS = 30_000;

/** Grace period for a worker to exit on its own after reporting a result. */
const REAP_DELAY_MS = 5_000;

/**
 * Represents the options for file conversion.
 *
 * @property {string} input - The path to the input file.
 * @property {string} output - The path to the output file.
 * @property {boolean} delete - Whether to delete the input file after conversion. Defaults to false.
 * @property {boolean} silent - Whether to suppress output during conversion. Defaults to true.
 * @property {low | med | high} verbose - The verbosity level of the calibre conversion process. Defaults to low.
 * @property {string} cover - The path or URL to the cover image file.
 * @property {number} timeoutMs - Maximum time in milliseconds to allow the underlying
 *   `ebook-convert` process to run before it is killed with SIGKILL. Defaults to 120000.
 */
export declare interface ConversionOptions {
    input: string;
    output: string;
    delete: boolean | undefined;
    silent: boolean | undefined;
    verbose?: "low" | "med" | "high";
    cover?: string;
    timeoutMs?: number;
}

/**
 * Represents the result of a file conversion operation.
 * @interface ConversionResult
 * @property {boolean} success - Indicates whether the conversion was successful.
 * @property {string} filePath - The full path where the converted file was saved.
 * @property {string} filename - The name of the converted file without extension.
 * @property {string} extension - The file extension of the converted file.
 * @property {string} [error] - Optional error message if the conversion failed.
 */
export declare interface ConversionResult {
    success: boolean;
    filePath: string;
    filename: string;
    extension: string;
    error?: string;
}

/**
 * @deprecated Retained only for backward compatibility of the public type
 * surface. The pool no longer holds live `Worker` instances while requests wait
 * for a slot -- workers are constructed at dispatch time instead.
 */
export interface WorkerItem {
    worker: Worker;
    port: MessagePort;
    options: ConversionOptions;
}

/** Additional, optional diagnostic detail attached to a {@link ConversionError}. */
export interface ConversionErrorDetail {
    stderr?: string;
    stdout?: string;
    code?: number | string | null;
    signal?: string | null;
    killed?: boolean;
    timedOut?: boolean;
    queueFull?: boolean;
}

/**
 * Error rejected from {@link convert} when a conversion fails.
 *
 * This is a real `Error` (so it carries a stack trace), but it also exposes the
 * `success` / `outputPath` / `error` properties that previous versions rejected
 * as a plain object literal, so existing consumers reading `err.error` as a
 * string continue to work unchanged. Everything else is purely additive.
 */
export class ConversionError extends Error {
    /** Always `false`. Present for backward compatibility. */
    readonly success = false as const;
    /** The output path the failed conversion was targeting. */
    readonly outputPath: string;
    /** Human-readable failure message. Backward-compatible string field. */
    readonly error: string;
    /** `ebook-convert`'s stderr, where Calibre explains why it rejected a file. */
    readonly stderr?: string;
    /** `ebook-convert`'s stdout up to the point of failure. */
    readonly stdout?: string;
    /** Process exit code, or a spawn error code such as `ENOENT`. */
    readonly code?: number | string | null;
    /** Signal that terminated the process, e.g. `SIGKILL` on timeout. */
    readonly signal?: string | null;
    /** True when the process was killed rather than exiting on its own. */
    readonly killed?: boolean;
    /**
     * True when the conversion exceeded its timeout and was killed. Lets a
     * caller distinguish "it hung and we killed it" from "Calibre rejected
     * this file".
     */
    readonly timedOut?: boolean;
    /** True when the request was refused because the pending queue was full. */
    readonly queueFull?: boolean;

    constructor(outputPath: string, message: string, detail: ConversionErrorDetail = {}) {
        super(message);
        this.name = 'ConversionError';
        this.outputPath = outputPath;
        this.error = message;
        if (detail.stderr !== undefined) this.stderr = detail.stderr;
        if (detail.stdout !== undefined) this.stdout = detail.stdout;
        if (detail.code !== undefined) this.code = detail.code;
        if (detail.signal !== undefined) this.signal = detail.signal;
        if (detail.killed !== undefined) this.killed = detail.killed;
        if (detail.timedOut !== undefined) this.timedOut = detail.timedOut;
        if (detail.queueFull !== undefined) this.queueFull = detail.queueFull;
    }
}

/**
 * Sets the path to the Calibre installation directory.
 *
 * @param path - The path to the Calibre installation directory.
 *
 * @example
 * ```typescript
 * setCalibrePath('/path/to/calibre');
 * ```
 */
export function setCalibrePath(_path: string) {
    if (!_path || _path.trim() === '') {
        console.warn('[calibre-node][thread-main] Calibre path not provided. Reverting to system PATH.');
        calibrePath = '';
        return;
    }
    calibrePath = path.resolve(process.cwd(), _path);
    console.log(`[calibre-node][thread-main] Calibre path set to ${calibrePath}`);
}


/**
 * Sets the size of the worker pool.
 *
 * This is the maximum number of worker threads that may exist at once. Unlike
 * previous versions, worker threads are no longer created until a pool slot is
 * free, so this now bounds actual thread and memory usage rather than only
 * bounding how many conversions execute concurrently.
 *
 * @param size - The desired size of the worker pool. If a value less than 1 is provided, the pool size will default to 1.
 *
 * @example
 * ```typescript
 * setPoolSize(5); // Sets the worker pool size to 5
 * ```
 */
export function setPoolSize(size: number) {
    if (size < 1) {
        console.warn('[calibre-node][thread-main] Pool size must be at least 1. Defaulting to 1.');
        poolSize = 1;
    } else {
        poolSize = size;
    }
    console.log(`[calibre-node][thread-main] Worker pool size set to ${poolSize}`);
}

/**
 * Sets the maximum number of conversions allowed to wait for a free pool slot.
 *
 * Once this many requests are already queued, further {@link convert} calls
 * reject immediately with `queueFull: true` instead of growing the queue without
 * bound. Defaults to {@link DEFAULT_MAX_QUEUE_SIZE}.
 *
 * @param size - Maximum pending queue length. Values below 1 are clamped to 1.
 *   Pass `Infinity` to restore the previous unbounded behaviour.
 *
 * @example
 * ```typescript
 * setMaxQueueSize(500);
 * ```
 */
export function setMaxQueueSize(size: number) {
    if (!(size >= 1)) {
        console.warn('[calibre-node][thread-main] Max queue size must be at least 1. Defaulting to 1.');
        maxQueueSize = 1;
    } else {
        maxQueueSize = size;
    }
    console.log(`[calibre-node][thread-main] Max queue size set to ${maxQueueSize}`);
}

/** Returns the current worker pool size. */
export function getPoolSize(): number {
    return poolSize;
}

/** Returns the current maximum pending queue length. */
export function getMaxQueueSize(): number {
    return maxQueueSize;
}

/** Returns the number of workers currently running a conversion. */
export function getActiveCount(): number {
    return pool.activeCount;
}

/** Returns the number of conversions waiting for a free pool slot. */
export function getPendingCount(): number {
    return pool.pendingCount;
}

interface ConversionTask {
    workerData: Record<string, unknown>;
    resolvedOutput: string;
    timeoutMs: number;
    silent: boolean;
    resolve: (result: ConversionResult) => void;
    reject: (error: ConversionError) => void;
}

/**
 * Dispatches one conversion. This is the only place a `Worker` is constructed,
 * and the pool guarantees it is called only when a slot is free.
 */
const runTask = (task: ConversionTask, done: () => void): void => {
    const { resolvedOutput, workerData, silent } = task;

    const log = (message: string) => {
        if (!silent) console.log(`[calibre-node][thread-main] ${message}`);
    };

    let settled = false;
    let watchdog: NodeJS.Timeout | undefined = undefined;
    let reaper: NodeJS.Timeout | undefined;
    let worker: Worker | undefined;

    const clearTimers = () => {
        if (watchdog) clearTimeout(watchdog);
        if (reaper) clearTimeout(reaper);
    };

    /**
     * Schedules a forced `terminate()` if the worker does not exit on its own
     * shortly after reporting its result, so a wedged thread cannot outlive the
     * conversion it was created for.
     */
    const scheduleReap = () => {
        if (!worker) return;
        reaper = setTimeout(() => {
            worker?.terminate().catch(() => { /* already gone */ });
        }, REAP_DELAY_MS);
        reaper.unref?.();
    };

    const settleSuccess = () => {
        if (settled) return;
        settled = true;
        if (watchdog) clearTimeout(watchdog);
        scheduleReap();
        task.resolve({
            success: true,
            filePath: resolvedOutput,
            filename: path.basename(resolvedOutput),
            extension: path.extname(resolvedOutput).slice(1),
        });
    };

    const settleFailure = (message: string, detail: ConversionErrorDetail = {}) => {
        if (settled) return;
        settled = true;
        if (watchdog) clearTimeout(watchdog);
        scheduleReap();
        task.reject(new ConversionError(resolvedOutput, message, detail));
    };

    try {
        worker = new Worker(path.join(__dirname, './converter.js'), { workerData });
    } catch (err) {
        // Free the slot before reporting, so a systemic failure to spawn
        // workers cannot wedge the pool.
        done();
        task.reject(
            new ConversionError(resolvedOutput, `Failed to start worker: ${(err as Error).message}`)
        );
        return;
    }

    const channel = new MessageChannel();

    channel.port2.on('message', (message: unknown) => {
        const failure = message as WorkerFailurePayload | undefined;
        if (failure && typeof failure === 'object' && ERROR_MARKER in failure) {
            settleFailure(failure.error, {
                stderr: failure.stderr,
                stdout: failure.stdout,
                code: failure.code,
                signal: failure.signal,
                killed: failure.killed,
                timedOut: failure.timedOut,
            });
            return;
        }
        settleSuccess();
    });

    channel.port2.on('messageerror', (err: Error) => {
        settleFailure(err.message);
    });

    worker.on('error', (err: Error) => {
        settleFailure(err.message);
    });

    worker.on('exit', (code: number) => {
        // The slot is only truly free once the OS thread is gone. Freeing here
        // (rather than when the result arrives) keeps `poolSize` an honest
        // bound on live threads -- and, critically, this runs on *every*
        // terminal path including failures, which previously leaked a slot
        // forever because only the success path closed the message channel.
        clearTimers();
        if (!settled) {
            settleFailure(`Worker stopped with exit code ${code}`, { code });
        }
        log(`Worker exited with code ${code}`);
        done();
    });

    // Guards against the worker thread itself wedging. The child process has
    // its own timeout, so this should not fire in practice.
    watchdog = setTimeout(() => {
        settleFailure(
            `Conversion did not report back within ${task.timeoutMs + WATCHDOG_GRACE_MS}ms; terminating worker`,
            { timedOut: true, killed: true }
        );
        worker?.terminate().catch(() => { /* already gone */ });
    }, task.timeoutMs + WATCHDOG_GRACE_MS);
    watchdog.unref?.();

    worker.postMessage({ port: channel.port1 }, [channel.port1]);
};

const pool = new WorkPool<ConversionTask>(runTask, {
    poolSize: () => poolSize,
    maxQueueSize: () => maxQueueSize,
});

/**
 * Converts your input file to the desired format.
 * Just provide the input and output paths, and any additional options you want to pass to the conversion command.
 * It identifies the file format based on the input file extension and converts it to the format specified by the output file extension.
 *
 * Additional options which are supported by Calibre can be passed as key-value pairs in the options object. See {@link https://manual.calibre-ebook.com/generated/en/ebook-convert.html}
 *
 * @param {ConversionOptions} data - The options for the conversion. See {@link ConversionOptions}.
 * @returns {Promise<ConversionResult>} A promise that resolves when the conversion is complete. See {@link ConversionResult}.
 *
 * @throws {Error} If not called from the main thread.
 *
 * @example
 * ```javascript
 * const { convert } = require('calibre-node');
 *
 * convert({
 *    input: './sample.pdf',
 *    output: './sample.epub',
 *    authors: 'Sample Author',
 *    title: 'Sample Title'
 * }).then(result => {
 *   console.log(result.success ? 'Conversion successful!' : 'Conversion failed!');
 * }).catch(err => {
 *  console.error(err);
 * });
 *
 *
 * This function handles the conversion for you, setting up workers and managing them to ensure everything runs smoothly.
 */
export function convert(data: ConversionOptions): Promise<ConversionResult> {
    if (!isMainThread) return Promise.reject(new Error('Not in main thread'));
    if (data.silent === undefined) data.silent = true;
    if (data.delete === undefined) data.delete = false;

    const log = (message: string) => {
        if (!data.silent) {
            console.log(`[calibre-node][thread-main] ${message}`);
        }
    };

    return new Promise<ConversionResult>((resolve, reject) => {
        const resolvedInput = path.resolve(process.cwd(), data.input);
        const resolvedOutput = path.resolve(process.cwd(), data.output);

        // Fail fast on the main thread, before paying for a worker, so an
        // unrecognised verbosity level is reported against the caller rather
        // than surfacing as an opaque worker error.
        if (data.verbose !== undefined) {
            try {
                assertValidVerbose(data.verbose);
            } catch (err) {
                reject(new ConversionError(resolvedOutput, (err as Error).message));
                return;
            }
        }

        if (data.timeoutMs !== undefined && !(data.timeoutMs > 0)) {
            reject(
                new ConversionError(
                    resolvedOutput,
                    `Invalid "timeoutMs" value: ${JSON.stringify(data.timeoutMs)}. Expected a positive number.`
                )
            );
            return;
        }

        log(`Input file ${resolvedInput}`);
        log(`Output will be saved to ${resolvedOutput}`);

        const timeoutMs = data.timeoutMs ?? DEFAULT_TIMEOUT_MS;

        const accepted = pool.trySubmit({
            workerData: {
                ...data,
                input: resolvedInput,
                output: resolvedOutput,
                calibrePath,
            },
            resolvedOutput,
            timeoutMs,
            silent: data.silent !== false,
            resolve,
            reject,
        });

        if (!accepted) {
            reject(
                new ConversionError(
                    resolvedOutput,
                    `Conversion queue is full (${maxQueueSize} requests pending). Try again later.`,
                    { queueFull: true }
                )
            );
        }
    });
}
