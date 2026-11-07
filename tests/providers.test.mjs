import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { Providers, configuration } from '../src/providers.mjs';
import { startHttp } from '../src/http.mjs';

async function directory(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bridge-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function smtp(t) {
  const messages = [];
  const server = net.createServer(socket => {
    socket.setEncoding('utf8');
    socket.write('220 localhost ESMTP test\r\n');
    let buffered = '';
    let data = false;
    let content = [];
    let recipients = [];
    socket.on('data', chunk => {
      buffered += chunk;
      while (buffered.includes('\r\n')) {
        const end = buffered.indexOf('\r\n');
        const line = buffered.slice(0, end);
        buffered = buffered.slice(end + 2);
        if (data) {
          if (line === '.') {
            messages.push({ recipients: [...recipients], content: content.join('\n') });
            recipients = [];
            content = [];
            data = false;
            socket.write('250 queued\r\n');
          } else content.push(line);
        } else if (/^EHLO/.test(line)) socket.write('250-localhost\r\n250 8BITMIME\r\n');
        else if (/^RCPT TO:/.test(line)) { recipients.push(line); socket.write('250 accepted\r\n'); }
        else if (/^DATA/.test(line)) { data = true; socket.write('354 end with dot\r\n'); }
        else if (/^QUIT/.test(line)) socket.end('221 goodbye\r\n');
        else socket.write('250 OK\r\n');
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { messages, env: { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(server.address().port), SMTP_FROM: 'sender@example.org' } };
}

const draft = { to: 'one@example.org', subject: 'Test batch', body: 'This is a local SMTP protocol test.' };

test('missing provider accounts are explicit and never reported as configured', async t => {
  const providers = new Providers({ env: {}, dataRoot: await directory(t) });
  assert.deepEqual(configuration({}), { smtp: false, movies: false, skin: false });
  await assert.rejects(providers.movieSearch(), /TMDB_API_TOKEN/);
  await assert.rejects(providers.startSkin({}), /YOUCAM_API_KEY/);
  const batch = await providers.createBatch([draft]);
  await assert.rejects(providers.sendBatch(batch.id), /SMTP_HOST/);
  assert.equal((await providers.mail.get(batch.id)).deliveries[0].status, 'pending');
});

test('SMTP delivers real MIME and replay or concurrent workers do not send duplicates', async t => {
  const endpoint = await smtp(t);
  const dataRoot = await directory(t);
  const a = new Providers({ env: endpoint.env, dataRoot });
  const b = new Providers({ env: endpoint.env, dataRoot });
  const batch = await a.createBatch([draft, { ...draft, to: 'two@example.org' }]);
  const duplicate = await b.createBatch([draft, { ...draft, to: 'two@example.org' }]);
  assert.equal(batch.id, duplicate.id);
  await Promise.all([a.sendBatch(batch.id), b.sendBatch(batch.id)]);
  await a.sendBatch(batch.id);
  assert.equal(endpoint.messages.length, 2);
  assert.match(endpoint.messages[0].content, /This is a local SMTP protocol test/);
  assert.deepEqual((await a.mail.get(batch.id)).deliveries.map(delivery => delivery.status), ['sent', 'sent']);
});

test('SMTP ambiguous failures and interrupted deliveries are not automatically resent', async t => {
  let calls = 0;
  const transport = { sendMail: async () => { calls++; throw new Error('Connection dropped'); } };
  const provider = new Providers({ env: { SMTP_FROM: 'sender@example.org' }, transport, dataRoot: await directory(t) });
  const batch = await provider.createBatch([draft]);
  await provider.sendBatch(batch.id);
  await provider.sendBatch(batch.id);
  assert.equal(calls, 1);
  assert.equal((await provider.mail.get(batch.id)).deliveries[0].status, 'unknown');
  const interrupted = await provider.createBatch([{ ...draft, subject: 'Interrupted' }]);
  interrupted.deliveries[0].status = 'sending';
  await provider.mail.put(interrupted.id, interrupted);
  await provider.sendBatch(interrupted.id);
  assert.equal(calls, 1);
  assert.equal((await provider.mail.get(interrupted.id)).deliveries[0].status, 'unknown');
});

test('mail validation rejects duplicate recipients, header injection and empty content', async t => {
  const provider = new Providers({ dataRoot: await directory(t) });
  await assert.rejects(provider.createBatch([draft, draft]), /once per batch/);
  await assert.rejects(provider.createBatch([{ ...draft, subject: 'Hello\r\nBcc: other@example.org' }]), /single-line/);
  await assert.rejects(provider.createBatch([{ ...draft, to: 'one@example.org,two@example.org' }]), /valid recipient/);
  await assert.rejects(provider.createBatch([{ ...draft, body: '' }]), /message/);
});

test('TMDB search encodes queries and returns live results with correct paging', async t => {
  const provider = new Providers({ env: { TMDB_API_TOKEN: 'test-token' }, dataRoot: await directory(t),
    fetcher: async (url, options) => {
      assert.equal(new URL(url).searchParams.get('query'), 'A & B');
      assert.equal(new URL(url).searchParams.get('page'), '2');
      assert.equal(options.headers.Authorization, 'Bearer test-token');
      return Response.json({ page: 2, total_pages: 4, total_results: 70,
        results: [{ id: 42, title: 'A & B', overview: '<sample>', release_date: '2024-01-01' }] });
    } });
  const result = await provider.movieSearch({ query: 'A & B', page: 2 });
  assert.equal(result.totalPages, 4);
  assert.equal(result.films[0].id, 'tmdb-42');
  assert.equal(result.films[0].summary, '<sample>');
});

test('provider authorization, rate limits and network failures produce useful errors', async t => {
  const root = await directory(t);
  for (const status of [401, 403, 429, 500]) {
    const provider = new Providers({ env: { TMDB_API_TOKEN: 'private-token' }, dataRoot: root,
      fetcher: async () => new Response('{}', { status }) });
    await assert.rejects(provider.movieSearch(), error => !error.message.includes('private-token') && error.status >= 400);
  }
  const broken = new Providers({ env: { TMDB_API_TOKEN: 'test' }, dataRoot: root,
    fetcher: async () => { throw new Error('socket'); } });
  await assert.rejects(broken.movieSearch(), /could not be reached/);
});

test('YouCam registers and uploads the image before task creation, then returns running and success', async t => {
  const calls = [];
  let polls = 0;
  const provider = new Providers({ env: { YOUCAM_API_KEY: 'test-key' }, dataRoot: await directory(t),
    fetcher: async (url, options) => {
      calls.push({ url: String(url), options });
      if (String(url).endsWith('/v2.0/file')) return Response.json({ data: { files: [{
        file_id: 'file-id', requests: [{ method: 'PUT', url: 'https://uploads.example.org/photo', headers: { 'Content-Type': 'image/png' } }],
      }] } });
      if (String(url).includes('uploads.example.org')) {
        assert.equal(options.headers.Authorization, undefined);
        assert.ok(Buffer.isBuffer(options.body));
        return new Response('');
      }
      if (options.method === 'POST') {
        assert.equal(JSON.parse(options.body).src_file_id, 'file-id');
        assert.equal(JSON.parse(options.body).format, 'json');
        return Response.json({ data: { task_id: 'remote-task' } });
      }
      return Response.json({ data: { task_status: polls++ ? 'success' : 'running',
        results: { output: [{ type: 'texture', raw_score: 60, ui_score: 70 }] } } });
    } });
  const task = await provider.startSkin({ contentType: 'image/png', image: Buffer.from([137,80,78,71,13,10,26,10,0]) });
  assert.equal(calls.length, 3);
  assert.equal((await provider.skinStatus(task.id)).status, 'running');
  assert.equal((await provider.skinStatus(task.id)).results.output[0].ui_score, 70);
});

test('YouCam upload rejection never creates a billable analysis task', async t => {
  let created = false;
  const provider = new Providers({ env: { YOUCAM_API_KEY: 'test-key' }, dataRoot: await directory(t),
    fetcher: async (url) => {
      if (String(url).endsWith('/v2.0/file')) return Response.json({ data: { files: [{
        file_id: 'file-id', requests: [{ method: 'PUT', url: 'https://uploads.example.org/photo', headers: {} }],
      }] } });
      if (String(url).includes('uploads.example.org')) return new Response('', { status: 403 });
      created = true;
      return Response.json({});
    } });
  await assert.rejects(provider.startSkin({ contentType: 'image/png', image: Buffer.from([137,80,78,71,13,10,26,10]) }), /upload was rejected/);
  assert.equal(created, false);
});

test('HTTP requires same-origin requests and keeps configuration secrets off static routes', async t => {
  const root = await directory(t);
  const provider = new Providers({ env: { TMDB_API_TOKEN: 'private-key' }, dataRoot: root });
  const server = await startHttp({ projects: [{ name: 'postroom-csv', folder: root, available: true }], providers: provider });
  t.after(() => server.close());
  const status = await fetch(server.url + '/postroom-csv/api/status');
  assert.equal((await status.text()).includes('private-key'), false);
  const rejected = await fetch(server.url + '/postroom-csv/api/mail/batches', {
    method: 'POST', headers: { Origin: 'https://outside.example', 'Content-Type': 'application/json' },
    body: JSON.stringify({ drafts: [draft] }),
  });
  assert.equal(rejected.status, 403);
  const hidden = await fetch(server.url + '/postroom-csv/.env');
  assert.equal(hidden.status, 404);
});

test('HTTP serves valid media byte ranges and rejects reversed or empty ranges', async t => {
  const root = await directory(t);
  await writeFile(path.join(root, 'sample.mp4'), '0123456789');
  const server = await startHttp({ projects: [{ name: 'sample', folder: root, available: true }],
    providers: new Providers({ env: {}, dataRoot: root }) });
  t.after(() => server.close());
  const url = server.url + '/sample/sample.mp4';
  const first = await fetch(url, { headers: { Range: 'bytes=0-3' } });
  assert.equal(first.status, 206);
  assert.equal(await first.text(), '0123');
  const suffix = await fetch(url, { headers: { Range: 'bytes=-2' } });
  assert.equal(await suffix.text(), '89');
  for (const value of ['bytes=8-2', 'bytes=-0', 'bytes=90-', 'bytes=-']) {
    assert.equal((await fetch(url, { headers: { Range: value } })).status, 416);
  }
});
