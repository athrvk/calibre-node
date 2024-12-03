import fs from 'fs';
import { parentPort } from 'worker_threads';
import execPromise from './execPromise';
import { performance } from 'perf_hooks';
import { ConversionParams } from '../typings/converter';

if (!parentPort) throw new Error('This script must be run as a worker thread!');

const getConversionParams = (): ConversionParams => {
    return process.env as ConversionParams;
};

const buildCommand = (inputPath: string, outputPath: string, params: ConversionParams): string => {
    const nonFlagParams = ['input', 'output', 'delete', 'silent'];
    let command = `ebook-convert "${inputPath}" "${outputPath}"`;

    Object.keys(params).forEach(key => {
        if (nonFlagParams.includes(key)) return;
        if (params[key] !== undefined && [true, 'true'].includes(params[key])) {
            command += ` --${key}`;
        } else {
            command += ` --${key}="${params[key]}"`;
        }
    });

    return command;
};

const handleConversion = async (params: ConversionParams, value: any) => {
    const inputPath = params.input;
    const outputPath = params.output;

    if (!inputPath || !fs.existsSync(inputPath)) {
        throw new Error(`Input path ${inputPath} not found!`);
    }

    const startTime = performance.now();
    const command = buildCommand(inputPath, outputPath, params);

    const log = (message: string) => {
        if (params.silent !== 'true') {
            console.log(message);
        }
    };

    log(`Starting conversion for ${inputPath}...`);

    try {
        const message = await execPromise(command);
        const duration = performance.now() - startTime;
        log(`Conversion completed in ${duration}ms`);

        value.port.postMessage({ ...params, message, duration });
        value.port.close();

        if (params.delete === 'true') {
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

parentPort.once('message', (value) => {
    const params = getConversionParams();
    handleConversion(params, value).catch(err => {
        console.error(err);
        process.exit(1);
    });
});