import path from 'node:path';
import { mkdir, realpath } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { selectProject } from './registry.mjs';

export async function runVideo({ projects, step, arguments: args = [], env = process.env }) {
  const project = selectProject(projects, 'video-edit-workbench');
  const pythonSteps = ['preflight', 'transcribe', 'cuts', 'build', 'verify', 'loudness', 'sfx', 'mix'];
  const nodeSteps = ['render', 'audit'];
  if (![...pythonSteps, ...nodeSteps].includes(step)) throw new Error('Unknown video step.');
  if (args.length > 40 || args.some(arg => typeof arg !== 'string' || arg.length > 2000)) throw new Error('Invalid video arguments.');
  const workspace = path.resolve(env.PROJECT_WORKSPACE || './workspace');
  await mkdir(workspace, { recursive: true });
  const cwd = await realpath(workspace);
  const python = env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const command = pythonSteps.includes(step) ? python : process.execPath;
  const script = path.join(project.folder, 'scripts', step + (pythonSteps.includes(step) ? '.py' : '.mjs'));
  const actual = pythonSteps.includes(step) && !['sfx', 'loudness'].includes(step)
    ? [script, '--project', cwd, ...args] : [script, ...args];
  return new Promise((resolve, reject) => {
    const process = spawn(command, actual, { cwd, env, shell: false, windowsHide: true });
    let output = '';
    const append = chunk => { output = (output + chunk.toString()).slice(-40000); };
    process.stdout.on('data', append);
    process.stderr.on('data', append);
    const timer = setTimeout(() => process.kill(), 15 * 60 * 1000);
    process.on('error', error => { clearTimeout(timer); reject(new Error('Could not launch the video runtime: ' + error.code)); });
    process.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ step, code, signal, workspace: cwd, output });
    });
  });
}
