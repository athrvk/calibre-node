import { execFile } from 'child_process';

/**
 * Default wall-clock budget for a single `ebook-convert` invocation.
 *
 * Rationale: a legitimate document conversion is dominated by parsing and
 * rendering work that finishes in seconds, and even a large, image-heavy PDF on
 * a slow shared CPU lands well inside a minute. 120s therefore leaves roughly
 * an order of magnitude of headroom over the realistic worst case while still
 * bounding the pathological case: `ebook-convert` is known to spin forever on
 * certain malformed or adversarial inputs, and without a ceiling a single such
 * file permanently consumes a pool slot. Callers with unusually large documents
 * can raise this per conversion via `ConversionOptions.timeoutMs`.
 */
export const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Upper bound on captured stdout/stderr.
 *
 * Node's `execFile` default is 1 MiB, and exceeding it kills the child with
 * ENOBUFS -- which, with `--verbose --verbose`, a long conversion can genuinely
 * hit and would surface as a spurious conversion failure. 10 MiB is ample for
 * Calibre's chattiest output while still bounding worker memory.
 */
export const MAX_BUFFER_BYTES = 10 * 1024 * 1024;

/** Result of a successful process execution. */
export interface ExecResult {
    stdout: string;
    stderr: string;
}

export interface ExecOptions {
    /** Wall-clock timeout in milliseconds. Defaults to {@link DEFAULT_TIMEOUT_MS}. */
    timeoutMs?: number;
    /** Maximum stdout/stderr bytes to buffer. Defaults to {@link MAX_BUFFER_BYTES}. */
    maxBuffer?: number;
}

/**
 * Error thrown when the executed process fails, is killed, or times out.
 *
 * Carries the diagnostic detail that `execFile` exposes but which was
 * previously discarded -- most importantly `stderr`, which is where
 * `ebook-convert` explains *why* it rejected a file.
 */
export class ExecError extends Error {
    /** Captured stdout up to the point of failure. */
    readonly stdout: string;
    /** Captured stderr up to the point of failure -- the useful diagnostic. */
    readonly stderr: string;
    /** Process exit code, or a spawn error code such as `ENOENT`. `null` when killed by signal. */
    readonly code: number | string | null;
    /** Signal that terminated the process, e.g. `SIGKILL` on timeout. */
    readonly signal: NodeJS.Signals | null;
    /** True when Node killed the process (timeout or explicit kill). */
    readonly killed: boolean;
    /**
     * True when the process was killed specifically because it exceeded the
     * timeout, as opposed to exiting non-zero on its own. Lets a caller
     * distinguish "it hung and we killed it" from "Calibre rejected this file".
     */
    readonly timedOut: boolean;
    /** The timeout that was in force, in milliseconds. */
    readonly timeoutMs: number;

    constructor(
        message: string,
        detail: {
            stdout: string;
            stderr: string;
            code: number | string | null;
            signal: NodeJS.Signals | null;
            killed: boolean;
            timedOut: boolean;
            timeoutMs: number;
        }
    ) {
        super(message);
        this.name = 'ExecError';
        this.stdout = detail.stdout;
        this.stderr = detail.stderr;
        this.code = detail.code;
        this.signal = detail.signal;
        this.killed = detail.killed;
        this.timedOut = detail.timedOut;
        this.timeoutMs = detail.timeoutMs;
    }
}

/**
 * Executes a binary without a shell, passing arguments as a literal array.
 *
 * Using `execFile` (instead of `exec`) means arguments are never interpreted by
 * a shell, so values such as file paths and Calibre option values cannot be used
 * to inject additional commands.
 *
 * The child is always run under a timeout and killed with `SIGKILL` if it
 * overruns, so a hung process can never wedge the caller indefinitely.
 *
 * @param file - The executable to run.
 * @param args - The list of arguments passed verbatim to the executable.
 * @param options - Timeout and buffer overrides.
 * @returns A promise resolving with the process stdout and stderr.
 * @throws {ExecError} If the process fails, is killed, or times out.
 */
const execPromise = (
    file: string,
    args: string[] = [],
    options: ExecOptions = {}
): Promise<ExecResult> => {
    const timeoutMs =
        typeof options.timeoutMs === 'number' && options.timeoutMs > 0
            ? options.timeoutMs
            : DEFAULT_TIMEOUT_MS;
    const maxBuffer = options.maxBuffer ?? MAX_BUFFER_BYTES;

    return new Promise((resolve, reject) => {
        execFile(
            file,
            args,
            { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer },
            (error, stdout, stderr) => {
                const out = stdout?.toString() ?? '';
                const err = stderr?.toString() ?? '';

                if (error) {
                    // `execFile` reports a timeout kill as killed + the kill
                    // signal with no exit code. A process killed by an external
                    // SIGKILL looks the same, but from this library's point of
                    // view both mean "it did not finish on its own", and the
                    // timeout is the only kill we ever issue.
                    const killed = error.killed === true;
                    const signal = (error.signal ?? null) as NodeJS.Signals | null;
                    const timedOut = killed && signal === 'SIGKILL';

                    const message = timedOut
                        ? `Process timed out after ${timeoutMs}ms and was killed with SIGKILL: ${file}`
                        : error.message;

                    reject(
                        new ExecError(message, {
                            stdout: out,
                            stderr: err,
                            code: error.code ?? null,
                            signal,
                            killed,
                            timedOut,
                            timeoutMs,
                        })
                    );
                    return;
                }
                resolve({ stdout: out, stderr: err });
            }
        );
    });
};

export default execPromise;
