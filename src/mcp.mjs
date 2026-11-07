import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { configuration } from './providers.mjs';
import { runVideo } from './video.mjs';

export async function startMcp({ projects, providers, browser, env = process.env }) {
  const server = new McpServer({ name: 'project-agent-bridge', version: '1.0.0' });
  const project = z.enum(projects.map(project => project.name));
  const tool = (name, description, inputSchema, handler, readOnlyHint = false) => {
    server.registerTool(name, { description, inputSchema, annotations: { readOnlyHint } }, async (args) => {
      try {
        const result = await handler(args);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: error.message }] };
      }
    });
  };
  tool('collection_status', 'List installed projects and whether external provider credentials are configured.', {},
    async () => ({ projects: projects.map(({ name, available, kind }) => ({ name, available, kind })),
      services: configuration(env) }), true);
  tool('project_open', 'Open a local web project and read its visible text and interactive controls.', { project },
    ({ project }) => browser.serial(() => browser.snapshot(project)), true);
  tool('project_action', 'Use a local project control. Read project_open first to find IDs and labels.', {
    project, action: z.enum(['click', 'fill', 'select', 'press', 'check', 'range']),
    selector: z.string().min(1).max(500), value: z.string().max(20000).default(''),
  }, args => browser.serial(() => browser.action(args)));
  tool('project_export', 'Click an export control and save the downloaded file under local artifacts.', {
    project, selector: z.string().min(1).max(500),
  }, args => browser.serial(() => browser.export(args)));
  tool('project_drag', 'Drag within a canvas or SVG using normalized coordinates between 0 and 1.', {
    project, selector: z.string().min(1).max(500),
    fromX: z.number().min(0).max(1), fromY: z.number().min(0).max(1),
    toX: z.number().min(0).max(1), toY: z.number().min(0).max(1),
  }, args => browser.serial(async () => {
    const page = await browser.page(args.project);
    const box = await page.locator(args.selector).boundingBox();
    if (!box) throw new Error('The drawing surface is not visible.');
    await page.mouse.move(box.x + args.fromX * box.width, box.y + args.fromY * box.height);
    await page.mouse.down();
    try { await page.mouse.move(box.x + args.toX * box.width, box.y + args.toY * box.height, { steps: 12 }); }
    finally { await page.mouse.up(); }
    return browser.snapshot(args.project);
  }));
  server.registerTool('project_screenshot', {
    description: 'Return a PNG screenshot of the local web project.', inputSchema: { project },
    annotations: { readOnlyHint: true },
  }, ({ project }) => browser.serial(async () => {
    try {
      const page = await browser.page(project);
      return { content: [{ type: 'image', mimeType: 'image/png',
        data: (await page.screenshot({ fullPage: false })).toString('base64') }] };
    } catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
  }));
  if (projects.some(project => project.name === 'night-cinema')) {
    tool('movie_search', 'Search live TMDB movies or list popular movies. Requires TMDB_API_TOKEN.', {
      query: z.string().max(200).default(''), page: z.number().int().min(1).max(500).default(1),
      language: z.string().default('en-US'),
    }, args => providers.movieSearch(args), true);
  }
  if (projects.some(project => project.name === 'postroom-csv')) {
    tool('mail_prepare', 'Create a reviewable, durable mail batch without sending messages.', {
      drafts: z.array(z.object({ to: z.string(), subject: z.string(), body: z.string() })).min(1).max(500),
    }, ({ drafts }) => providers.createBatch(drafts));
    tool('mail_send', 'Send a reviewed mail batch using SMTP. Only call after the user authorizes those recipients and content. Completed deliveries are not resent.', {
      batchId: z.string().regex(/^[a-f0-9]{64}$/), confirmSend: z.literal(true),
    }, ({ batchId }) => providers.sendBatch(batchId));
  }
  if (projects.some(project => project.name === 'routine-notebook')) {
    tool('skin_analyze', 'Upload a consenting user image to YouCam and start cosmetic skin analysis. Requires YOUCAM_API_KEY.', {
      imagePath: z.string().min(1), consent: z.literal(true),
    }, async ({ imagePath }) => {
      const workspace = await realpath(path.resolve(env.PROJECT_WORKSPACE || './workspace'));
      const file = await realpath(path.resolve(workspace, imagePath));
      if (!file.startsWith(workspace + path.sep)) throw new Error('Put the image inside PROJECT_WORKSPACE.');
      const extension = path.extname(file).toLowerCase();
      if (!['.png', '.jpg', '.jpeg'].includes(extension)) throw new Error('Choose a PNG or JPEG file.');
      return providers.startSkin({ image: await readFile(file), name: path.basename(file),
        contentType: extension === '.png' ? 'image/png' : 'image/jpeg' });
    });
    tool('skin_status', 'Read the status and results of a previously started YouCam analysis.', {
      taskId: z.string().uuid(),
    }, ({ taskId }) => providers.skinStatus(taskId), true);
  }
  if (projects.some(project => project.name === 'video-edit-workbench')) {
    tool('video_run', 'Run one installed video pipeline step in PROJECT_WORKSPACE. Requires the video dependencies described in that repository.', {
      step: z.enum(['preflight', 'transcribe', 'cuts', 'build', 'verify', 'loudness', 'sfx', 'mix', 'render', 'audit']),
      arguments: z.array(z.string().max(2000)).max(40).default([]),
    }, args => runVideo({ projects, ...args, env }));
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return { server, transport };
}
