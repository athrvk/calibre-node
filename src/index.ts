import { Worker, isMainThread, MessageChannel } from 'worker_threads';
import path from 'path';
import { ConversionOptions, ConversionResult, WorkerItem } from '../typings/index';

let poolSize = 2;
let executionQueue: WorkerItem[] = [];
const idleQueue: WorkerItem[] = [];


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
        console.warn('Pool size must be at least 1. Defaulting to 1.');
        poolSize = 1;
    } else {
        poolSize = size;
    }
    console.log(`Worker pool size set to ${poolSize}`);
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

    const log = (message: string) => {
        if (!data.silent) {
            console.log(message);
        }
    };

    const getVerbosity = (level: string | undefined) : NodeJS.Dict<string> => {
        let verbosity = {};
        if (level === "med") verbosity =  { verbose: "true" };
        if (level === "high") verbosity = { verbose: "true", v: "true" };
        return verbosity;
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
        const resolvedOutput = path.resolve(process.cwd(), data.output);

        const worker = new Worker(path.join(__dirname, './converter.js'), {
            env: {
                ...data,
                input: resolvedInput,
                output: resolvedOutput,
                delete: (data.delete || false).toString(),
                silent: (data.silent || true).toString(),
                ...getVerbosity(data.verbose)
            }
        });

        const channel = new MessageChannel();
        const onMessage = (message: any) => {
            log(`Worker with id ${worker.threadId} completed conversion`);
            resolve({
                success: true,
                outputPath: resolvedOutput,
                ...message
            });
        };
        const onClose = () => {
            log(`Channel closed for worker with id ${worker.threadId}`);
            removeWorkerFromQueue(worker.threadId);
        }
        const onExit = (code: number) => {
            if (code !== 0) {
                log(`Worker with id ${worker.threadId} stopped with exit code ${code}`);
                reject({
                    success: false,
                    outputPath: resolvedOutput,
                    error: `Worker stopped with exit code ${code}`
                });
            }
        };

        channel.port2.on('message', onMessage);
        channel.port2.on('close', onClose);
        worker.on('exit', onExit);

        addWorkerToQueue({ worker, port: channel.port1, options: data });
    });
}
