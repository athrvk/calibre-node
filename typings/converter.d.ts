export interface ConversionParams {
    input: string;
    output: string;
    delete: boolean;
    silent: boolean;
    calibrePath: string;
    [key: string]: string | boolean;
}