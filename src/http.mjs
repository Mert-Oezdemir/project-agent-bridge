import http from 'node:http';
import { realpath, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { configuration, ServiceError } from './providers.mjs';

const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.mp4': 'video/mp4',
  '.json': 'application/json', '.wav': 'audio/wav' };

async function body(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 14 * 1024 * 1024) throw new ServiceError('The request is too large.', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ServiceError('Provide a valid JSON request.'); }
}

function json(response, value, status = 200) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

export async function startHttp({ projects, providers, port = 0 }) {
  const server = http.createServer(async (request, response) => {
    try {
      const host = request.headers.host || '';
      if (!/^127\.0\.0\.1:\d+$/.test(host)) throw new ServiceError('Use the loopback URL printed by this server.', 403);
      const url = new URL(request.url, 'http://' + host);
      if (request.headers.origin && request.headers.origin !== url.origin) throw new ServiceError('Cross-origin access is disabled.', 403);
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('Referrer-Policy', 'no-referrer');
      if (request.method === 'POST' && request.headers['x-project-request'] !== '1') throw new ServiceError('Missing request header.', 403);

      const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      const project = projects.find(project => project.name === segments[0] && project.available);
      if (!project) {
        if (url.pathname === '/' && request.method === 'GET') {
          return json(response, { projects: projects.map(({ name, available, kind }) => ({ name, available, kind })) });
        }
        throw new ServiceError('Project not found.', 404);
      }
      const api = segments.slice(1).join('/');
      if (api === 'api/status' && request.method === 'GET') {
        return json(response, { services: configuration(providers.env) });
      }
      if (project.name === 'night-cinema' && api === 'api/movies' && request.method === 'GET') {
        return json(response, await providers.movieSearch({
          query: url.searchParams.get('query') || '', page: Number(url.searchParams.get('page') || 1),
          language: url.searchParams.get('language') || 'en-US',
        }));
      }
      if (project.name === 'postroom-csv') {
        if (api === 'api/mail/batches' && request.method === 'POST') {
          return json(response, await providers.createBatch((await body(request)).drafts), 201);
        }
        if (segments[1] === 'api' && segments[2] === 'mail' && segments[3] === 'batches' && segments[4]) {
          const id = segments[4];
          if (!/^[a-f0-9]{64}$/.test(id)) throw new ServiceError('Invalid batch ID.');
          if (segments[5] === 'send' && segments.length === 6 && request.method === 'POST') {
            return json(response, await providers.sendBatch(id));
          }
          if (segments.length === 5 && request.method === 'GET') {
            const batch = await providers.mail.get(id);
            if (!batch) throw new ServiceError('Batch not found.', 404);
            return json(response, batch);
          }
        }
      }
      if (project.name === 'routine-notebook') {
        if (api === 'api/skin/tasks' && request.method === 'POST') {
          const input = await body(request);
          if (input.consent !== true) throw new ServiceError('Confirm that the image may be sent to the analysis provider.');
          if (typeof input.image !== 'string' || !/^[a-zA-Z0-9+/]*={0,2}$/.test(input.image)) throw new ServiceError('Invalid image data.');
          return json(response, await providers.startSkin({ ...input, image: Buffer.from(input.image, 'base64') }), 201);
        }
        if (segments[1] === 'api' && segments[2] === 'skin' && segments[3] === 'tasks' &&
            segments.length === 5 && request.method === 'GET') {
          if (!/^[a-f0-9-]{36}$/.test(segments[4])) throw new ServiceError('Invalid task ID.');
          return json(response, await providers.skinStatus(segments[4]));
        }
      }
      if (request.method !== 'GET' || segments[1] === 'api') throw new ServiceError('Endpoint not found.', 404);
      if (project.kind === 'video' && segments.length === 1) {
        response.writeHead(302, { Location: '/' + project.name + '/template/?demo' });
        response.end();
        return;
      }
      let relative = segments.slice(1).join('/') || 'index.html';
      if (url.pathname.endsWith('/') && segments.length > 1) relative += '/index.html';
      if (relative.split('/').some(part => part.startsWith('.')) || !types[path.extname(relative)]) {
        throw new ServiceError('File not found.', 404);
      }
      const videoWorkspace = project.kind === 'video' && ['scene', 'work', 'src', 'out'].includes(segments[1]);
      const base = await realpath(videoWorkspace ? providers.env.PROJECT_WORKSPACE : project.folder);
      let file;
      try { file = await realpath(path.resolve(base, relative)); }
      catch { throw new ServiceError('File not found.', 404); }
      if (!file.startsWith(base + path.sep)) throw new ServiceError('File not found.', 404);
      const info = await stat(file);
      if (!info.isFile()) throw new ServiceError('File not found.', 404);
      let start = 0, end = info.size - 1;
      if (request.headers.range) {
        const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range);
        if (!range || (!range[1] && !range[2])) throw new ServiceError('Invalid byte range.', 416);
        start = range[1] ? Number(range[1]) : Math.max(0, info.size - Number(range[2]));
        end = range[1] && range[2] ? Math.min(Number(range[2]), info.size - 1) : info.size - 1;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= info.size) {
          response.setHeader('Content-Range', 'bytes */' + info.size);
          throw new ServiceError('The requested range is outside this file.', 416);
        }
        response.setHeader('Content-Range', 'bytes ' + start + '-' + end + '/' + info.size);
      }
      response.writeHead(request.headers.range ? 206 : 200, {
        'Content-Type': types[path.extname(file)], 'Cache-Control': 'no-store',
        'Accept-Ranges': 'bytes', 'Content-Length': Math.max(0, end - start + 1),
      });
      if (!info.size) { response.end(); return; }
      const stream = createReadStream(file, { start, end });
      stream.on('error', () => response.destroy());
      response.on('close', () => stream.destroy());
      stream.pipe(response);
    } catch (error) {
      if (!response.headersSent) json(response, { error: error instanceof ServiceError ? error.message : 'The request could not be completed.' },
        error.status || 500);
      else response.end();
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { server, url: 'http://127.0.0.1:' + server.address().port,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}
