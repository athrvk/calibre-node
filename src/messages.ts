/**
 * The message protocol between the main thread and a conversion worker.
 *
 * This lives in its own module because `converter.ts` throws on import when it
 * is not running inside a worker thread, so `index.ts` must not import runtime
 * values from it.
 */

/**
 * Marker property identifying a structured failure posted back to the main
 * thread. Failures are reported over the message channel -- rather than by
 * exiting non-zero and letting the main thread synthesise a generic
 * "worker stopped with exit code 1" -- so that Calibre's stderr, exit code and
 * timeout status survive the thread boundary and reach the caller.
 */
export const ERROR_MARKER = '__calibreNodeError';

export interface WorkerFailurePayload {
    [ERROR_MARKER]: true;
    error: string;
    stack?: string;
    stdout?: string;
    stderr?: string;
    code?: number | string | null;
    signal?: string | null;
    killed?: boolean;
    timedOut?: boolean;
}
