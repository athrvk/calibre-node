#!/usr/bin/env node

import { Command } from 'commander';
import { installCalibre } from './cli/install';
import { version } from '../package.json';

const program = new Command();

program
    .name('calibre-node')
    .description('A lightweight, high-performance Node.js ebook conversion library powered by Calibre.')
    .version(version);

program
    .command('install calibre')
    .description('Install Calibre based on your operating system. Note: Requires Python to be installed on your system if you are on Linux.')
    .option('--install_dir <path>', 'Specify the installation directory')
    .action(installCalibre);

program.parse(process.argv);