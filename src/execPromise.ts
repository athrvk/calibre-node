import { exec } from 'child_process';

const execPromise = (command: string): Promise<string> => {
    return new Promise((resolve, reject) => {
        exec(command, (error, stdout) => {
            if (error) {
                reject(error);
                return;
            }
            resolve(stdout);
        });
    });
}

export default execPromise;