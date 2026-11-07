import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { projectNames } from '../src/registry.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const projectRoot = process.env.BRIDGE_TEST_PROJECTS || path.dirname(root);

test('MCP client discovers tools, opens 14 apps, edits and exports a profile, and reports missing account keys', async t => {
  try { await access(path.join(projectRoot, 'profile-launchpad', 'index.html')); }
  catch { t.skip('Set BRIDGE_TEST_PROJECTS to a directory containing the collection repositories.'); return; }
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'bridge-mcp-'));
  const workspace = path.join(temporary, 'workspace');
  await mkdir(workspace);
  t.after(async () => {
    assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()));
    await rm(temporary, { recursive: true, force: true });
  });
  const transport = new StdioClientTransport({
    command: process.execPath, args: [path.join(root, 'bin/bridge.mjs'), 'mcp', '--root', projectRoot],
    env: { ...process.env, BRIDGE_DATA_DIR: path.join(temporary, 'data'), PROJECT_WORKSPACE: workspace,
      TMDB_API_TOKEN: '', YOUCAM_API_KEY: '', SMTP_HOST: '', SMTP_FROM: '' },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'collection-acceptance', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(transport);
  const names = (await client.listTools()).tools.map(tool => tool.name);
  for (const name of ['collection_status', 'project_action', 'project_drag', 'project_export', 'movie_search',
    'skin_analyze', 'skin_status', 'mail_prepare', 'mail_send', 'video_run']) assert.ok(names.includes(name));
  const call = (name, args = {}) => client.callTool({ name, arguments: args });
  const content = result => JSON.parse(result.content[0].text);
  const state = content(await call('collection_status'));
  assert.equal(state.projects.filter(project => project.available).length, 15);
  assert.deepEqual(state.services, { smtp: false, movies: false, skin: false });
  for (const project of projectNames.filter(project => project !== 'video-edit-workbench')) {
    const result = await call('project_open', { project });
    assert.notEqual(result.isError, true, project + ': ' + result.content?.[0]?.text);
    assert.ok(content(result).controls.length > 0, project);
  }
  await call('project_action', { project: 'profile-launchpad', action: 'fill', selector: '#name', value: 'Agent demo' });
  const saved = content(await call('project_export', { project: 'profile-launchpad',
    selector: 'button[type="submit"]' }));
  assert.match(await readFile(saved.file, 'utf8'), /Agent demo/);
  const screenshot = await call('project_screenshot', { project: 'profile-launchpad' });
  assert.equal(screenshot.content[0].mimeType, 'image/png');
  assert.ok(screenshot.content[0].data.length > 1000);
  const movie = await call('movie_search', { query: 'Example' });
  assert.equal(movie.isError, true);
  assert.match(movie.content[0].text, /TMDB_API_TOKEN/);
  const video = content(await call('video_run', { step: 'preflight' }));
  assert.equal(video.code, 1);
  assert.match(video.output, /edl.json/);
});
