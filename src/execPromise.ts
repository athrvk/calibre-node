import { execFile } from 'child_process';

/**
 * Executes a binary without a shell, passing arguments as a literal array.
 *
 * Using `execFile` (instead of `exec`) means arguments are never interpreted by
 * a shell, so values such as file paths and Calibre option values cannot be used
 * to inject additional commands.
 *
 * @param file - The executable to run.
 * @param args - The list of arguments passed verbatim to the executable.
 * @returns A promise resolving with the process stdout.
 */
const execPromise = (file: string, args: string[] = []): Promise<string> => {
    return new Promise((resolve, reject) => {
        execFile(file, args, (error, stdout) => {
            if (error) {
                reject(error);
                return;
            }
            resolve(stdout);
        });
    });
}

export default execPromise;
