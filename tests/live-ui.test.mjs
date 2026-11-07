import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRuntime } from '../src/index.mjs';
import { Providers } from '../src/providers.mjs';

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const projectRoot = process.env.BRIDGE_TEST_PROJECTS || path.dirname(packageRoot);

test('live UI flows send reviewed mail, page TMDB results and upload a photo for an asynchronous analysis result', async t => {
  try { await access(path.join(projectRoot, 'routine-notebook', 'analysis.js')); }
  catch { t.skip('Set BRIDGE_TEST_PROJECTS to the collection repositories.'); return; }
  const folder = await mkdtemp(path.join(os.tmpdir(), 'bridge-ui-'));
  t.after(async () => {
    assert.equal(path.dirname(folder), path.resolve(os.tmpdir()));
    await rm(folder, { recursive: true, force: true });
  });
  const sent = [];
  let uploaded = false;
  let taskCreated = false;
  const env = { SMTP_HOST: 'test-smtp', SMTP_FROM: 'sender@example.org',
    TMDB_API_TOKEN: 'test-movie', YOUCAM_API_KEY: 'test-skin' };
  const providers = new Providers({ env, dataRoot: path.join(folder, 'services'),
    transport: { sendMail: async options => {
      sent.push(options);
      return { accepted: [options.to], messageId: options.messageId };
    } },
    fetcher: async (address, options) => {
      const url = new URL(address);
      if (url.hostname === 'api.themoviedb.org') {
        const page = Number(url.searchParams.get('page'));
        return Response.json({ page, total_pages: 2, total_results: 2,
          results: [{ id: page, title: 'Live film <img src=x onerror=alert(1)> ' + page,
            overview: 'A provider result.', release_date: '2025-01-01' }] });
      }
      if (url.pathname.endsWith('/v2.0/file')) return Response.json({ data: { files: [{
        file_id: 'uploaded-file', requests: [{ method: 'PUT', url: 'https://upload.example.org/photo', headers: {} }],
      }] } });
      if (url.hostname === 'upload.example.org') {
        assert.equal(options.headers.Authorization, undefined);
        uploaded = options.body.length > 100;
        return new Response('');
      }
      if (options.method === 'POST') {
        assert.equal(uploaded, true);
        taskCreated = true;
        return Response.json({ data: { task_id: 'skin-task' } });
      }
      return Response.json({ data: { task_status: 'success',
        results: { output: [{ type: 'texture', raw_score: 60, ui_score: 70, mask_urls: [] }] } } });
    } });
  const runtime = await createRuntime({ root: projectRoot, env: { ...process.env, ...env,
    BRIDGE_DATA_DIR: path.join(folder, 'runtime'), PROJECT_WORKSPACE: path.join(folder, 'workspace') }, providers });
  t.after(() => runtime.close());
  const mail = await runtime.browser.page('postroom-csv');
  await mail.waitForFunction(() => !document.querySelector('#prepare-send').disabled);
  await mail.locator('#csv').fill('email,name\none@example.org,One\ntwo@example.org,Two');
  await mail.locator('#validate').click();
  await mail.locator('#prepare-send').click();
  await mail.waitForFunction(() => document.querySelector('#send-review li'));
  await mail.locator('#send-consent').check();
  await mail.locator('#send-batch').click();
  await mail.waitForFunction(() => document.querySelector('#send-status').textContent.includes('2 sent'));
  assert.equal(sent.length, 2);
  assert.match(sent[1].subject, /Two/);

  const movies = await runtime.browser.page('night-cinema');
  await movies.locator('#source').selectOption('live');
  await movies.waitForFunction(() => document.querySelector('#page-info').textContent === 'Page 1 of 2');
  assert.equal(await movies.locator('#films img').count(), 0);
  await movies.locator('#next-page').click();
  await movies.waitForFunction(() => document.querySelector('#page-info').textContent === 'Page 2 of 2');
  await movies.locator('[data-film="tmdb-2"]').click();
  await movies.reload();
  await movies.locator('#source').selectOption('live');
  await movies.locator('#saved-only').click();
  await movies.waitForFunction(() => document.querySelector('[data-film="tmdb-2"]'));
  assert.equal(await movies.locator('#films li').count(), 1);

  const skin = await runtime.browser.page('routine-notebook');
  const encoded = await skin.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 480;
    canvas.getContext('2d').fillRect(0, 0, 480, 480);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  await skin.locator('#skin-photo').setInputFiles({
    name: 'synthetic.png', mimeType: 'image/png', buffer: Buffer.from(encoded, 'base64'),
  });
  await skin.locator('#skin-consent').check();
  await skin.waitForFunction(() => !document.querySelector('#skin-start').disabled);
  await skin.locator('#skin-start').click();
  await skin.waitForFunction(() => document.querySelector('#analysis-status').textContent.includes('Analysis completed'));
  assert.equal(taskCreated, true);
  assert.match(await skin.locator('#analysis-results').innerText(), /provider score 70/);
  const exported = await runtime.browser.export({ project: 'routine-notebook', selector: '#skin-export' });
  const result = JSON.parse(await readFile(exported.file, 'utf8'));
  assert.equal(result.results.output[0].type, 'texture');
});
