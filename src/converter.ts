import fs from 'fs';
import { parentPort, workerData, threadId } from 'worker_threads';
import execPromise from './execPromise';
import { performance } from 'perf_hooks';

export interface ConversionParams {
    input: string;
    output: string;
    delete: boolean;
    silent: boolean;
    calibrePath: string;
    [key: string]: string | boolean;
}

if (!parentPort) throw new Error('This script must be run as a worker thread!');

const logPrefix = `[calibre-node][thread-${threadId}] `;

const getConversionParams = (): ConversionParams => {
    return workerData as ConversionParams;
};

const buildCommand = (inputPath: string, outputPath: string, params: ConversionParams): string => {
    const nonFlagParams = ['input', 'output', 'delete', 'silent', 'calibrePath'];
    const calibrePath = params.calibrePath === '' ? '' : params.calibrePath + '/';
    let command = `ebook-convert "${inputPath}" "${outputPath}"`;

    Object.keys(params).forEach(key => {
        if (nonFlagParams.includes(key)) return;
        if (key === 'verbose' && params[key] === 'low') return;
        if (key === 'verbose' && params[key] === 'med') {
            command += ' --verbose';
        } else if (key === 'verbose' && params[key] === 'high') {
            command += ' --verbose --verbose';
        } else if (params[key] !== undefined && [true, 'true'].includes(params[key])) {
            command += ` --${key}`;
        } else {
            command += ` --${key}="${params[key]}"`;
        }
    });

    return calibrePath + command;
};

const handleConversion = async (params: ConversionParams, value: any) => {
    const inputPath = params.input;
    const outputPath = params.output;

    if (!inputPath || !fs.existsSync(inputPath)) {
        throw new Error(`${logPrefix}Input path ${inputPath} not found!`);
    }

    const startTime = performance.now();
    const command = buildCommand(inputPath, outputPath, params);

    const log = (message: string) => {
        if (!params.silent) {
            message = `${logPrefix}${message}`;
            console.log(message);
        }
    };

    try {
        log(`Starting conversion:`)
        log(command);
        const stdout = await execPromise(command);
        
        if (params.verbose)
            stdout.split('\n').forEach(_log => console.log("[calibre] " + _log));
        
        const duration = performance.now() - startTime;
        log(`Conversion completed in ${duration.toFixed(3)} ms`);

        value.port.postMessage({ ...params });
        value.port.close();

        if (params.delete) {
            fs.unlink(inputPath, (err) => {
                if (err) throw err;
                log(`Deleted input file ${inputPath}`);
            });
        }
    } catch (err) {
        log(`Conversion failed: ${(err as Error).message}`);
        process.exit(1);
    }
};

const checkCalibre = async (calibrePath: string) => {
    try {
        calibrePath = calibrePath === '' ? '' : calibrePath + '/';
        await execPromise(calibrePath + 'ebook-convert --version');
    } catch (err) {
        const message = (err as Error).message;
        if (message.includes('not found')) {
            console.error(logPrefix + 'Calibre executable not found in ' + (calibrePath === '' ? 'system PATH' : `specified path: ${calibrePath}`));
            console.error(logPrefix + 'Calibre is not installed. Please install it from https://calibre-ebook.com/download');
        } else {
            console.error(logPrefix + message);
        }
        process.exit(1);
    }
};

parentPort.once('message', async (value) => {
    const params = getConversionParams();
    await checkCalibre(params.calibrePath);
    handleConversion(params, value).catch(err => {
        console.error(logPrefix + err.message);
        process.exit(1);
    });
});