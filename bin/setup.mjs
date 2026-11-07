#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { projectNames } from '../src/registry.mjs';

const envFile = process.env.PROJECT_ENV_FILE || path.resolve('.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);
const root = path.resolve(path.dirname(envFile), process.env.PROJECTS_ROOT || './projects');
await mkdir(root, { recursive: true });
let failed = false;
for (const name of projectNames) {
  const folder = path.join(root, name);
  if (existsSync(folder)) {
    if (!existsSync(path.join(folder, 'README.md'))) { console.error(name + ': folder exists but is incomplete.'); failed = true; }
    else console.log(name + ': already installed.');
    continue;
  }
  const result = spawnSync('git', ['clone', '--branch', 'main', '--single-branch',
    'https://github.com/Mert-Oezdemir/' + name + '.git', folder], { stdio: 'inherit', shell: false, windowsHide: true });
  if (result.status !== 0) failed = true;
}
if (failed) process.exitCode = 1;
