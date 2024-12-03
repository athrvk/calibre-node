export interface ConversionParams {
    input: string;
    output: string;
    delete: boolean | string;
    silent: boolean | string;
    [key: string]: string | boolean;
}