import { MessagePort, Worker } from "worker_threads";

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
export interface ConversionOptions {
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
export interface ConversionResult {
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