export interface ConversionParams {
    input: string;
    output: string;
    delete: boolean | string;
    silent: boolean | string;
    calibrePath: string;
    [key: string]: string | boolean;
}