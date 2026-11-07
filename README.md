# Project Agent Bridge

Run the collection locally and connect it to an MCP-compatible agent. The bridge serves the web applications, handles SMTP, TMDB and YouCam on the server, and exposes browser controls and video commands as agent tools.

## Install the collection

Install Node 22 or newer, Git and Chrome or Edge. Then run:

```sh
git clone https://github.com/Mert-Oezdemir/project-agent-bridge.git
cd project-agent-bridge
npm ci
npm run setup
npm start
```

Setup clones the 15 application repositories into `projects/`. It preserves existing folders. Start prints a local URL for each installed project.

If Chrome or Edge is not installed, run `npx playwright install chromium`. To choose another Chromium executable, set `CHROME` in `.env`.

## Connect external services

Copy `.env.example` to `.env`, fill the accounts you use, and restart the server.

- SMTP uses `SMTP_HOST`, `SMTP_PORT`, `SMTP_FROM`, `SMTP_USER`, `SMTP_PASS` and `SMTP_SECURE`. Port 587 uses STARTTLS. Port 465 uses TLS from the start. Use the app password or SMTP credentials supplied by your mail provider.
- TMDB uses the API Read Access Token in `TMDB_API_TOKEN`.
- Perfect Corp / YouCam uses `YOUCAM_API_KEY`. Your account must have access to Skin Analysis V2.1 and enough units.

Accounts and keys are not included. Run `npm run doctor` to see which connections are configured. This command reports configuration presence and does not claim to verify account validity.

Keys stay on the server. Each project also keeps its offline functionality available.

## Connect an agent

Run `npm run mcp:config --silent` to print an MCP configuration with absolute executable and project paths. Add its `mcpServers` entry to your MCP host. The generated configuration points to the local `.env` path and does not contain its contents.

The tools are:

- `collection_status` lists installed applications and service configuration.
- `project_open` returns page text and available controls.
- `project_action` clicks, fills, selects, checks, changes ranges and presses keys.
- `project_drag` moves a pointer across a canvas or SVG.
- `project_screenshot` returns a PNG image.
- `project_export` saves a file downloaded by an application.
- `movie_search` calls TMDB search or popular movies.
- `mail_prepare` creates a batch for review. `mail_send` sends the reviewed batch after user authorization.
- `skin_analyze` uploads a consenting user image from `PROJECT_WORKSPACE`. `skin_status` retrieves the result.
- `video_run` executes the supported video pipeline commands in `PROJECT_WORKSPACE`.

For a single repository, use its own `npm ci`, `npm start` and `npm run mcp:config --silent` commands. All repositories use this shared runtime.

Example agent request:

> Open Postroom CSV. Paste my CSV into its CSV control, validate the contacts, prepare personalized drafts and export the JSON for review.

Example direct tool call:

```json
{
  "name": "project_action",
  "arguments": {
    "project": "profile-launchpad",
    "action": "fill",
    "selector": "#name",
    "value": "Avery"
  }
}
```

Browser state in an MCP session lasts until that session closes. The regular web UI uses the user's normal browser storage. Exported agent files are stored in `.bridge/artifacts/`.

## Email delivery and retries

The app stores batches and each recipient's delivery status in `.bridge/mail/`. Identical draft content resolves to the same batch ID. A completed recipient is not resent if the same batch is called again, including calls from another local process.

An interrupted connection can leave the SMTP outcome uncertain. Such deliveries are marked `unknown` and require checking the mail provider before another send. The bridge does not claim final inbox delivery when SMTP acceptance alone is known. Rejected recipients and unknown deliveries remain visible in the review.

## Skin analysis

The browser validates JPEG/PNG size and dimensions, requests permission, uploads through a signed provider URL, and starts an asynchronous analysis. It saves the local task ID for later status checks. Rechecking a task does not create a new analysis. The image is sent to YouCam and is not written to local bridge storage.

The selected SD concerns are wrinkles, pores, texture and acne. Results show provider scores, detection-image links and downloadable JSON. These are cosmetic image observations. Human review is needed for health concerns.

## Video tools

Install the Python, FFmpeg, FFprobe, Chrome and transcription dependencies described in the video repository. Set `PYTHON` and `PROJECT_WORKSPACE` when needed. Command names are fixed and arguments are passed directly without a shell. A command can run for up to 15 minutes and returns its exit code and final output.

## Tests

`npm test` covers real local SMTP delivery, duplicate prevention, uncertain outcomes, provider response handling, HTTP access rules, MCP handshakes, browser exports and the three connected UI flows.

The collection browser tests use repositories installed alongside this package. If they are elsewhere, set `BRIDGE_TEST_PROJECTS` to their parent directory. Tests using external services run against local test providers. Real provider account checks require your credentials.

Official integration references are [MCP SDK](https://ts.sdk.modelcontextprotocol.io/server), [Nodemailer SMTP](https://nodemailer.com/smtp), [TMDB search](https://developer.themoviedb.org/docs/search-and-query-for-details), and [YouCam skin analysis](https://docs.perfectcorp.com/reference/ai_skin_analysis/standard-analysis/endpoint-overview).
