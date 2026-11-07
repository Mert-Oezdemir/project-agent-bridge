import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { selectProject } from './registry.mjs';

export class BrowserProjects {
  constructor({ projects, url, artifacts, env = process.env }) {
    this.projects = projects;
    this.url = url;
    this.artifacts = path.resolve(artifacts);
    this.env = env;
    this.pages = new Map();
    this.pending = Promise.resolve();
  }

  async start() {
    if (!this.browser) {
      const candidates = [
        this.env.CHROME,
        'C:/Program Files/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/usr/bin/google-chrome', '/usr/bin/chromium',
      ].filter(Boolean);
      const executablePath = candidates.find(candidate => existsSync(candidate));
      this.browser = await chromium.launch({ executablePath, headless: true });
      this.context = await this.browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
      // Browser state lasts for the current agent session. The normal web UI uses the user's browser storage.
    }
  }

  async page(name) {
    const project = selectProject(this.projects, name);
    if (project.kind !== 'web') throw new Error('Use video_run for the video project.');
    await this.start();
    if (!this.pages.has(name)) {
      const page = await this.context.newPage();
      await page.goto(this.url + '/' + name + '/');
      this.pages.set(name, page);
    }
    return this.pages.get(name);
  }

  async serial(action) {
    const current = this.pending.catch(() => {}).then(action);
    this.pending = current;
    return current;
  }

  async snapshot(name) {
    const page = await this.page(name);
    return { project: name, title: await page.title(), text: (await page.locator('body').innerText()).slice(0, 22000),
      controls: await page.locator('input,select,textarea,button,a[href],[tabindex="0"]').evaluateAll(nodes =>
        nodes.slice(0, 120).map(node => ({
          tag: node.tagName.toLowerCase(), id: node.id || null,
          label: node.getAttribute('aria-label') || node.labels?.[0]?.textContent.trim() || node.textContent.trim().slice(0, 100),
          type: node.type || null, value: node.type === 'file' ? null : node.value ?? null,
          disabled: Boolean(node.disabled),
        }))) };
  }

  async action({ project, action, selector, value }) {
    const page = await this.page(project);
    const control = page.locator(selector);
    if (action === 'click') await control.click({ timeout: 10000 });
    else if (action === 'fill') await control.fill(value, { timeout: 10000 });
    else if (action === 'select') await control.selectOption(value, { timeout: 10000 });
    else if (action === 'press') await control.press(value, { timeout: 10000 });
    else if (action === 'check') await control.setChecked(value === 'true', { timeout: 10000 });
    else if (action === 'range') await control.evaluate((node, value) => {
      if (node.type !== 'range') throw new Error('Choose a range input.');
      node.value = value;
      node.dispatchEvent(new Event('input', { bubbles: true }));
    }, value);
    else throw new Error('Unsupported browser action.');
    if (!page.url().startsWith(this.url + '/' + project + '/')) {
      await page.goto(this.url + '/' + project + '/');
      throw new Error('The control navigated away from the local project.');
    }
    return this.snapshot(project);
  }

  async export({ project, selector }) {
    const page = await this.page(project);
    const waiting = page.waitForEvent('download', { timeout: 15000 });
    await page.locator(selector).click({ timeout: 10000 });
    const download = await waiting;
    await mkdir(this.artifacts, { recursive: true });
    const filename = randomUUID() + '-' + path.basename(download.suggestedFilename()).replace(/[^a-zA-Z0-9._-]/g, '_');
    const destination = path.join(this.artifacts, filename);
    await download.saveAs(destination);
    return { project, file: destination, suggestedFilename: download.suggestedFilename() };
  }

  async close() { if (this.browser) await this.browser.close(); }
}
