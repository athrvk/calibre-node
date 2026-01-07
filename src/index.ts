import { MessagePort, Worker, isMainThread, MessageChannel } from 'worker_threads';
import path from 'path';

let poolSize = 2;
let executionQueue: WorkerItem[] = [];
const idleQueue: WorkerItem[] = [];
let calibrePath: string = '';

/**
 * Represents the options for file conversion.
 *
 * @property {string} input - The path to the input file.
 * @property {string} output - The path to the output file.
 * @property {boolean} delete - Whether to delete the input file after conversion. Defaults to false.
 * @property {boolean} silent - Whether to suppress output during conversion. Defaults to true.
 * @property {low | med | high} verbose - The verbosity level of the calibre conversion process. Defaults to low.
 * @property {string} cover - The path or URL to the cover image file.
 */
export declare interface ConversionOptions {
    input: string;
    output: string;
    delete: boolean | undefined;
    silent: boolean | undefined;
    verbose?: "low" | "med" | "high";
    cover?: string;
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

export interface WorkerItem {
    worker: Worker;
    port: MessagePort;
    options: ConversionOptions;
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
            message = `[calibre-node][thread-main] ${message}`;
            console.log(message);
        }
    };

    const removeWorkerFromQueue = (id: number) => {
        executionQueue = executionQueue.filter(item => item.worker.threadId !== id);
        refreshExecutionQueue();
    };

    const addWorkerToQueue = (item: WorkerItem) => {
        idleQueue.push(item);
        refreshExecutionQueue();
    };

    const refreshExecutionQueue = () => {
        if (executionQueue.length >= poolSize || idleQueue.length === 0) return;
        const item = idleQueue.shift();
        if (item) {
            executionQueue.push(item);
            item.worker.postMessage({ port: item.port }, [item.port]);
        }
    };

    return new Promise((resolve, reject) => {
        const resolvedInput = path.resolve(process.cwd(), data.input);
        log(`Input file ${resolvedInput}`);
        const resolvedOutput = path.resolve(process.cwd(), data.output);
        log(`Output will be saved to ${resolvedOutput}`);

        const worker = new Worker(path.join(__dirname, './converter.js'), {
            workerData: {
                ...data,
                input: resolvedInput,
                output: resolvedOutput,
                calibrePath
            }
        });

        const channel = new MessageChannel();
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const onMessage = (_message: any) => {
            // log(`Worker with id ${worker.threadId} completed conversion`);
            const result = {
                success: true,
                filePath: resolvedOutput,
                filename: path.basename(resolvedOutput),
                extension: path.extname(resolvedOutput).slice(1),
            }
            resolve(result);
        };
        const onClose = () => {
            // log(`Channel closed for worker with id ${worker.threadId}`);
            removeWorkerFromQueue(worker.threadId);
        }
        const onExit = (code: number) => {
            if (code !== 0) {
                // log(`Worker with id ${worker.threadId} stopped with exit code ${code}`);
                reject({
                    success: false,
                    outputPath: resolvedOutput,
                    error: `Worker stopped with exit code ${code}`
                });
            }
        };
        const onChannelMessageError = (err: Error) => {
            // log(`Channel for worker with id ${worker.threadId} encountered an error: ${err.message}`);
            reject({
                success: false,
                outputPath: resolvedOutput,
                error: err.message
            });
        }
        const onWorkerError = (err: Error) => {
            // log(`Worker with id ${worker.threadId} encountered an error: ${err.message}`);
            reject({
                success: false,
                outputPath: resolvedOutput,
                error: err.message
            });
        }

        channel.port2.on('message', onMessage);
        channel.port2.on('messageerror', onChannelMessageError);
        channel.port2.on('close', onClose);
        worker.on('exit', onExit);
        worker.on('error', onWorkerError);

        addWorkerToQueue({ worker, port: channel.port1, options: data });
    });
}
