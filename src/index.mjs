import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { registry } from './registry.mjs';
import { Providers, configuration } from './providers.mjs';
import { startHttp } from './http.mjs';
import { BrowserProjects } from './browser.mjs';
import { startMcp } from './mcp.mjs';

export async function createRuntime({ root, project, home = process.cwd(), env = process.env, port = 0, providers } = {}) {
  const projects = registry({ root, project });
  const dataRoot = path.resolve(env.BRIDGE_DATA_DIR || path.join(project ? root : home, '.bridge'));
  const workspace = path.resolve(env.PROJECT_WORKSPACE || path.join(project ? root : home, 'workspace'));
  env = { ...env, PROJECT_WORKSPACE: workspace };
  await mkdir(workspace, { recursive: true });
  providers ||= new Providers({ env, dataRoot });
  const http = await startHttp({ projects, providers, port });
  const browser = new BrowserProjects({ projects, url: http.url,
    artifacts: path.join(dataRoot, 'artifacts'), env });
  return { projects, providers, browser, http, env,
    close: async () => { await browser.close(); await http.close(); } };
}

export async function start(options = {}) {
  const root = path.resolve(options.root || process.cwd());
  const envFile = path.resolve(process.env.PROJECT_ENV_FILE || options.envFile || path.join(root, '.env'));
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  for (const key of ['PROJECTS_ROOT', 'PROJECT_WORKSPACE', 'BRIDGE_DATA_DIR']) {
    if (process.env[key]) process.env[key] = path.resolve(path.dirname(envFile), process.env[key]);
  }
  const mode = process.argv[2] || 'serve';
  if (mode === 'doctor') {
    console.log(JSON.stringify({ projects: registry(options).map(({ name, available, kind }) => ({ name, available, kind })),
      services: configuration(), node: process.version }, null, 2));
    return;
  }
  if (mode === 'config') {
    console.log(JSON.stringify({ mcpServers: {
      [options.project || 'project-collection']: { command: process.execPath,
        args: [path.resolve(process.argv[1]), 'mcp', '--root', root,
          ...(options.project ? ['--project', options.project] : [])],
        env: { PROJECT_ENV_FILE: envFile } },
    } }, null, 2));
    return;
  }
  if (!['serve', 'mcp'].includes(mode)) throw new Error('Use serve, mcp, doctor or config.');
  const runtime = await createRuntime({ ...options, home: path.dirname(envFile),
    port: mode === 'mcp' ? 0 : Number(process.env.PORT || 8787) });
  const cleanup = async () => { await runtime.close(); };
  process.once('SIGINT', async () => { await cleanup(); process.exit(0); });
  process.once('SIGTERM', async () => { await cleanup(); process.exit(0); });
  if (mode === 'mcp') {
    const mcp = await startMcp(runtime);
    mcp.transport.onclose = async () => { await cleanup(); process.exit(0); };
  } else {
    for (const project of runtime.projects.filter(project => project.available)) {
      console.log(project.name + ' ' + runtime.http.url + '/' + project.name + '/');
    }
  }
}
