import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import lockfile from 'proper-lockfile';

export class Store {
  constructor(folder) { this.folder = path.resolve(folder); this.locks = new Map(); }

  file(id) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error('Invalid record ID.');
    return path.join(this.folder, id + '.json');
  }

  async get(id) {
    try { return JSON.parse(await readFile(this.file(id), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }

  async put(id, record) {
    await mkdir(this.folder, { recursive: true });
    const destination = this.file(id);
    const temp = destination + '.' + randomUUID() + '.tmp';
    await writeFile(temp, JSON.stringify(record, null, 2), { mode: 0o600 });
    await rename(temp, destination);
    return record;
  }

  async lock(id, action) {
    const previous = this.locks.get(id) || Promise.resolve();
    const current = previous.catch(() => {}).then(async () => {
      await mkdir(this.folder, { recursive: true });
      const release = await lockfile.lock(this.file(id), { realpath: false,
        stale: 30000, update: 10000, retries: { retries: 12, minTimeout: 100, maxTimeout: 500 } });
      try { return await action(); }
      finally { await release(); }
    });
    this.locks.set(id, current);
    try { return await current; }
    finally { if (this.locks.get(id) === current) this.locks.delete(id); }
  }
}
