#!/usr/bin/env node
import { start } from '../src/index.mjs';
import path from 'node:path';
import { existsSync } from 'node:fs';

const envFile = process.env.PROJECT_ENV_FILE || path.resolve('.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);
if (process.env.PROJECTS_ROOT) process.env.PROJECTS_ROOT = path.resolve(path.dirname(envFile), process.env.PROJECTS_ROOT);

function option(name) {
  const index = process.argv.indexOf('--' + name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

await start({ root: path.resolve(option('root') || process.env.PROJECTS_ROOT || './projects'),
  project: option('project'), envFile });
