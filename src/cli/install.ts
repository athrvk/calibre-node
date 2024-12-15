import { exec } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import fs from 'fs';
import path from 'path';
import {select} from '@inquirer/prompts';
import chalk from 'chalk';

const execPromise = promisify(exec);

async function isCommandAvailable(command: string): Promise<boolean> {
    try {
        await execPromise(`command -v ${command}`);
        return true;
    } catch {
        return false;
    }
}

export async function installCalibre(): Promise<void> {
    const platform = os.platform();
    let installDir = path.resolve(__dirname, '../../calibre-bin');
    const installDirArg = process.argv.find(arg => arg.startsWith('--install_dir='));

    try {
        const addToGitignore = await select({
            message: 'Do you want to add calibre-bin to .gitignore?',
            choices: [
                {
                    name: 'Yes',
                    description: 'Recommended',
                    value: true
                },
                {
                    name: 'No',
                    value: false
                }
            ],
        });

        switch (platform) {
            case 'win32':
                console.log(chalk.blue('📥 Installation: Please download and install Calibre from https://calibre-ebook.com/download_windows'));
                break;
            case 'darwin':
                console.log(chalk.blue('📥 Installation: Please download and install Calibre from https://calibre-ebook.com/download_macos'));
                break;
            case 'linux':
                {
                    if (installDirArg) {
                        const customInstallDir = installDirArg.split('=')[1];
                        if (!fs.existsSync(customInstallDir)) {
                            console.log(chalk.yellow('ℹ️  Info: Custom installation directory does not exist. Creating directory...'));
                            fs.mkdirSync(customInstallDir, { recursive: true });
                        }
                        installDir = path.resolve(customInstallDir);
                    }
                    const installCalibre = await select({
                        message: `Calibre will be installed in ${installDir} directory. Do you want to proceed?`,
                        choices: [
                            {
                                name: 'Ok!',
                                value: true
                            },
                            {
                                name: 'Change installation directory',
                                value: false
                            }
                        ]
                    });

                    if (installCalibre) {
                        const wgetAvailable = await isCommandAvailable('wget');
                        const curlAvailable = await isCommandAvailable('curl');
                        if (wgetAvailable) {
                            console.log(chalk.cyan('🔄 Progress: Installing Calibre...'));
                            await execPromise(`wget -nv -O- https://download.calibre-ebook.com/linux-installer.sh | sh /dev/stdin install_dir=${installDir} isolated=y`);
                        } else if (curlAvailable) {
                            console.log(chalk.cyan('🔄 Progress: Installing Calibre...'));
                            await execPromise(`curl -sL https://download.calibre-ebook.com/linux-installer.sh | sh /dev/stdin install_dir=${installDir} isolated=y`);
                        } else {
                            console.error(chalk.red('❌ Error: Neither wget nor curl is installed. Please install one of them to proceed.'));
                            return;
                        }
                        console.log(chalk.green('✅ Success: Calibre has been installed in:'));
                        console.log(chalk.green(`   ${installDir}`));

                        if (addToGitignore) {
                            const gitignorePath = path.resolve(process.cwd(), '.gitignore');
                            if (fs.existsSync(gitignorePath)) {
                                fs.appendFileSync(gitignorePath, '\n\n# Ignore Calibre binary directory\ncalibre-bin\n');
                                console.log(chalk.cyan('📝 Info: Added calibre-bin to .gitignore'));
                            } else {
                                console.log(chalk.yellow('⚠️  Warning: .gitignore file not found in the project root.'));
                            }
                        }
                    } else {
                        console.log('\n' + chalk.yellow('⚠️  Installation aborted.'));
                        console.log(chalk.yellow('ℹ️  Tip: Run the command with arg --install_dir to specify a custom installation directory.'));
                        console.log(chalk.gray('   Example: npx calibre-node install calibre --install_dir=/path/to/install/in\n'));
                    }
                    break;
                }
            default:
                console.error(chalk.red('❌ Error: Unsupported operating system. Please install Calibre manually.'));
        }
    } catch (error) {
        console.error(chalk.red('❌ Error installing Calibre:'), error);
    }
}