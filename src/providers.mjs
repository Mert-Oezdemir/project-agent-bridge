import nodemailer from 'nodemailer';
import { createHash, randomUUID } from 'node:crypto';
import { Store } from './store.mjs';
import path from 'node:path';

export class ServiceError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export function configuration(env = process.env) {
  return {
    smtp: Boolean(env.SMTP_HOST && env.SMTP_FROM),
    movies: Boolean(env.TMDB_API_TOKEN),
    skin: Boolean(env.YOUCAM_API_KEY),
  };
}

export async function fetchJson(url, options = {}, fetcher = fetch) {
  let response;
  try { response = await fetcher(url, { ...options, signal: AbortSignal.timeout(30000), redirect: 'error' }); }
  catch { throw new ServiceError('The provider could not be reached. Try again later.', 502); }
  if (!response.ok) {
    const message = response.status === 401 || response.status === 403
      ? 'The provider rejected the configured account key.'
      : response.status === 429 ? 'The provider rate limit was reached. Try again later.'
        : 'The provider returned HTTP ' + response.status + '.';
    throw new ServiceError(message, response.status === 429 ? 429 : 502);
  }
  try { return await response.json(); }
  catch { throw new ServiceError('The provider returned an invalid JSON response.', 502); }
}

export class Providers {
  constructor({ env = process.env, dataRoot = './data', fetcher = fetch, transport } = {}) {
    this.env = env;
    this.fetcher = fetcher;
    this.transport = transport;
    this.mail = new Store(path.join(dataRoot, 'mail'));
    this.skin = new Store(path.join(dataRoot, 'skin'));
  }

  require(key, description) {
    if (!this.env[key]) throw new ServiceError('Configure ' + key + ' in .env to use ' + description + '.', 503);
    return this.env[key];
  }

  async movieSearch({ query = '', page = 1, language = 'en-US' } = {}) {
    const token = this.require('TMDB_API_TOKEN', 'live film search');
    if (typeof query !== 'string' || query.length > 200 || !Number.isInteger(page) || page < 1 || page > 500 ||
        !/^[a-z]{2}(?:-[A-Z]{2})?$/.test(language)) throw new ServiceError('Invalid movie search parameters.');
    const base = this.env.TMDB_BASE_URL || 'https://api.themoviedb.org/3';
    const url = new URL(base + (query.trim() ? '/search/movie' : '/movie/popular'));
    url.search = new URLSearchParams({ page: String(page), language, include_adult: 'false' });
    if (query.trim()) url.searchParams.set('query', query.trim());
    const result = await fetchJson(url, { headers: { Authorization: 'Bearer ' + token } }, this.fetcher);
    if (!Array.isArray(result.results)) throw new ServiceError('The film provider returned an unexpected response.', 502);
    return { page: result.page, totalPages: Math.min(result.total_pages || 0, 500),
      totalResults: result.total_results || 0,
      films: result.results.filter(movie => Number.isInteger(movie.id) && typeof movie.title === 'string').map(movie => ({
        id: 'tmdb-' + movie.id, title: movie.title, summary: movie.overview || '',
        year: (movie.release_date || '').slice(0, 4), rating: movie.vote_average,
        url: 'https://www.themoviedb.org/movie/' + movie.id,
      })) };
  }

  mailTransport() {
    if (this.transport) return this.transport;
    const host = this.require('SMTP_HOST', 'email sending');
    this.require('SMTP_FROM', 'email sending');
    const port = Number(this.env.SMTP_PORT || 587);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ServiceError('Invalid SMTP_PORT.');
    const local = ['localhost', '127.0.0.1', '::1'].includes(host);
    if (Boolean(this.env.SMTP_USER) !== Boolean(this.env.SMTP_PASS)) throw new ServiceError('Set both SMTP_USER and SMTP_PASS.');
    this.transport = nodemailer.createTransport({
      host, port, secure: this.env.SMTP_SECURE === 'true' || port === 465,
      requireTLS: !local && port !== 465,
      auth: this.env.SMTP_USER ? { user: this.env.SMTP_USER, pass: this.env.SMTP_PASS } : undefined,
      connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000,
      disableFileAccess: true, disableUrlAccess: true,
    });
    return this.transport;
  }

  async createBatch(drafts) {
    if (!Array.isArray(drafts) || !drafts.length || drafts.length > 500) throw new ServiceError('Provide between 1 and 500 drafts.');
    const seen = new Set();
    for (const draft of drafts) {
      if (!draft || typeof draft.to !== 'string' || !/^[^\s@<>\r\n,;]+@[^\s@<>\r\n,;]+\.[^\s@<>\r\n,;]+$/.test(draft.to) ||
          draft.to.length > 254 || typeof draft.subject !== 'string' || !draft.subject.trim() || /[\r\n]/.test(draft.subject) ||
          draft.subject.length > 240 || typeof draft.body !== 'string' || !draft.body.trim() || draft.body.length > 12000) {
        throw new ServiceError('Each draft needs one valid recipient, a single-line subject and a message.');
      }
      const address = draft.to.toLowerCase();
      if (seen.has(address)) throw new ServiceError('Each recipient may appear only once per batch.');
      seen.add(address);
    }
    const content = drafts.map(({ to, subject, body }) => ({ to, subject, body }));
    const id = createHash('sha256').update(JSON.stringify(content)).digest('hex');
    return this.mail.lock(id, async () => {
      const existing = await this.mail.get(id);
      if (existing) return existing;
      return this.mail.put(id, { id, createdAt: new Date().toISOString(),
        deliveries: content.map(draft => ({ ...draft, status: 'pending' })) });
    });
  }

  async sendBatch(id) {
    return this.mail.lock(id, async () => {
      const batch = await this.mail.get(id);
      if (!batch) throw new ServiceError('The mail batch does not exist.', 404);
      const transport = this.mailTransport();
      const from = this.require('SMTP_FROM', 'email sending');
      for (const delivery of batch.deliveries) {
        if (delivery.status === 'sending') {
          delivery.status = 'unknown';
          delivery.error = 'The previous send was interrupted. Check the provider before sending again.';
          await this.mail.put(id, batch);
        }
        if (delivery.status !== 'pending') continue;
        delivery.status = 'sending';
        await this.mail.put(id, batch);
        try {
          const result = await transport.sendMail({
            from, to: delivery.to, subject: delivery.subject, text: delivery.body,
            messageId: '<' + id + '.' + createHash('sha256').update(delivery.to).digest('hex').slice(0, 16) + '@postroom.local>',
          });
          delivery.status = result.accepted?.length ? 'sent' : 'rejected';
          delivery.messageId = result.messageId;
        } catch (error) {
          // A dropped connection after DATA can leave acceptance uncertain. Never resend automatically.
          delivery.status = error.responseCode >= 500 ? 'rejected' : 'unknown';
          delivery.error = delivery.status === 'unknown'
            ? 'Delivery outcome is unknown. Check the provider before sending again.'
            : 'The SMTP provider rejected this recipient.';
        }
        await this.mail.put(id, batch);
      }
      return batch;
    });
  }

  async startSkin({ image, contentType, name = 'photo.jpg', actions = ['wrinkle', 'pore', 'texture', 'acne'] }) {
    const token = this.require('YOUCAM_API_KEY', 'skin analysis');
    const allowed = ['wrinkle', 'pore', 'texture', 'acne', 'redness', 'oiliness', 'moisture', 'radiance'];
    if (!Buffer.isBuffer(image) || !image.length || image.length >= 10 * 1024 * 1024 ||
        !['image/jpeg', 'image/png'].includes(contentType) || !Array.isArray(actions) || !actions.length ||
        actions.some(action => !allowed.includes(action))) throw new ServiceError('Choose a JPEG or PNG below 10 MiB and valid skin concerns.');
    const jpeg = image[0] === 0xff && image[1] === 0xd8;
    const png = image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    if ((contentType === 'image/jpeg' && !jpeg) || (contentType === 'image/png' && !png)) throw new ServiceError('The image content does not match its type.');
    const base = this.env.YOUCAM_BASE_URL || 'https://yce-api-01.makeupar.com/s2s';
    const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
    const initialized = await fetchJson(base + '/v2.0/file', { method: 'POST', headers,
      body: JSON.stringify({ files: [{ file_name: name.slice(0, 120), content_type: contentType, file_size: image.length }] }) }, this.fetcher);
    const file = initialized.data?.files?.[0];
    if (!file?.file_id || !file.requests?.length) throw new ServiceError('The image provider did not return an upload target.', 502);
    for (const request of file.requests) {
      const url = new URL(request.url);
      const localTest = this.env.YOUCAM_BASE_URL && ['127.0.0.1', 'localhost'].includes(url.hostname);
      if ((!localTest && url.protocol !== 'https:') || request.method !== 'PUT') throw new ServiceError('The provider returned an invalid upload target.', 502);
      let upload;
      try { upload = await this.fetcher(url, { method: 'PUT', headers: request.headers, body: image,
        signal: AbortSignal.timeout(60000), redirect: 'error' }); }
      catch { throw new ServiceError('The photo upload failed. No analysis task was started.', 502); }
      if (!upload.ok) throw new ServiceError('The photo upload was rejected. No analysis task was started.', 502);
    }
    const task = await fetchJson(base + '/v2.1/task/skin-analysis', { method: 'POST', headers,
      body: JSON.stringify({ src_file_id: file.file_id, dst_actions: actions, format: 'json' }) }, this.fetcher);
    if (!task.data?.task_id) throw new ServiceError('The provider did not return a task ID.', 502);
    const id = randomUUID();
    await this.skin.put(id, { id, taskId: task.data.task_id, createdAt: new Date().toISOString() });
    return { id, status: 'running' };
  }

  async skinStatus(id) {
    const token = this.require('YOUCAM_API_KEY', 'skin analysis');
    const task = await this.skin.get(id);
    if (!task) throw new ServiceError('The analysis task does not exist.', 404);
    const base = this.env.YOUCAM_BASE_URL || 'https://yce-api-01.makeupar.com/s2s';
    const response = await fetchJson(base + '/v2.1/task/skin-analysis/' + encodeURIComponent(task.taskId),
      { headers: { Authorization: 'Bearer ' + token } }, this.fetcher);
    const data = response.data;
    if (!data || !['running', 'success', 'error'].includes(data.task_status)) throw new ServiceError('Unexpected analysis task status.', 502);
    return { id, status: data.task_status, results: data.results || null, error: data.error || null };
  }
}
