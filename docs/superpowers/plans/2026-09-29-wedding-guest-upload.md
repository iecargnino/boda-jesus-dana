# Wedding Guest Upload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A QR-linked web page where wedding guests upload photos and videos, without logging in, directly into the couple's Google Drive.

**Architecture:** A static guest page (vanilla JS ES modules, GitHub Pages) asks an Apps Script web app (`init`) for a Drive resumable-upload session URL, then PUTs the file to Drive in 8 MiB chunks with retry/resume. Apps Script runs as the Drive owner, validates input, checks quota, names the file and creates the session; it never receives file bytes.

**Tech Stack:** HTML/CSS/vanilla JS (ES modules), Google Apps Script (V8), Drive API v3 resumable uploads, Node 24 `node:test` (no dependencies), GitHub Pages via GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-29-wedding-upload-design.md`

## Global Constraints

- Event: Friday 2026-10-02. Device-tested by Thursday 2026-10-01.
- No guest login. Web app deployed with Execute as: Me, Access: Anyone (anonymous).
- Chunk size 8 MiB (multiple of 256 KiB). Files upload sequentially, one at a time.
- Max 5 attempts per chunk, exponential backoff 1s, 2s, 4s, 8s (cap 16s).
- Large-file confirm threshold: > 300 MB.
- Drive folder name: `Casamiento Jesús & Dana`. File name: `YYYY-MM-DD_HH-mm-ss_<Guest-Name>_<originalName>`, guest slug `Invitado` when empty, timezone `America/Argentina/Buenos_Aires`.
- Contract: `POST init { action: "init", fileName, mimeType, size, guestName?, origin? }` → `{ ok: true, uploadUrl }` | `{ ok: false, error: "no_space" | "invalid" | "server" }`. The client adds `"network"` locally.
- UI copy in Spanish; code, identifiers and comments in English.
- No runtime dependencies. Tests run with `npm test` (`node --test`).
- Free infrastructure only.

## Review Focus

1. **Files with an empty `file.type`** (some Android browsers give `""` for HEIC/MOV): the guest expects the upload to work, so the client infers the MIME type from the extension (Task 2 test `resolveMimeType`).
2. **Guest names and file names with accents, emoji, slashes or `..`**: the expected result is a safe, readable Drive name with no path injection (Task 5 tests `slugify` and `sanitizeFileName`).
3. **A 308 response with no readable `Range` header, or no progress**: the upload must not loop forever re-sending the same bytes, so no-progress 308s count as failed attempts (Task 4 test).
4. **Many guests uploading at the same moment on first use**: exactly one Drive folder must be created, via a script lock with a double-check (Task 5 test).
5. **The phone screen locks or the tab is closed mid-upload**: iOS kills background uploads, so the page holds a Wake Lock, warns on `beforeunload`, and shows Retry for failed files (Task 6 code, manual check in Task 7).

---

## File Structure

```
package.json                     # "type": "module", npm test script
.gitignore
web/                             # everything published to GitHub Pages
  index.html                     # guest page markup
  styles.css                     # mobile-first styles
  config.js                      # COUPLE_NAMES, INIT_ENDPOINT (swapped at handoff)
  app.js                         # DOM wiring: picker, queue, rows, wake lock
  lib/chunks.js                  # pure chunk / header / backoff math
  lib/format.js                  # pure byte formatting, large-file check, MIME inference
  lib/api.js                     # init client (POST to Apps Script)
  lib/uploader.js                # resumable upload engine (injected fetch/sleep)
apps-script/
  Code.gs                        # init endpoint (validation, quota, naming, session)
  appsscript.json                # manifest: V8, scopes, webapp settings
tests/
  chunks.test.js
  format.test.js
  api.test.js
  uploader.test.js
  apps-script.test.js            # loads Code.gs in node:vm with stubbed Google services
.github/workflows/pages.yml      # test + deploy web/ to GitHub Pages
docs/handoff-dana.md             # Spanish step-by-step guide for Dana
```

---

### Task 1: Spike — verify browser PUT to a Drive resumable session (throwaway)

This is the design's biggest risk. It checks that a session created by Apps Script with an `Origin` header accepts cross-origin chunk PUTs from the browser, and that the `Range` header is readable. Nothing from this task gets committed.

**Files:**
- Create (throwaway, not committed): `spike/Code.gs`, `spike/index.html`

**Interfaces:**
- Consumes: nothing
- Produces: a go/no-go answer recorded in `odd/tasks/wedding-guest-upload.md`: (a) can the browser PUT chunks cross-origin? (b) is `Range` readable on a 308?

- [ ] **Step 1: Write the spike Apps Script**

`spike/Code.gs`:

```js
function doPost(e) {
  var b = JSON.parse(e.postData.contents);
  var res = UrlFetchApp.fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable', {
    method: 'post',
    contentType: 'application/json; charset=UTF-8',
    payload: JSON.stringify({ name: 'spike_' + b.fileName }),
    headers: {
      Authorization: 'Bearer ' + ScriptApp.getOAuthToken(),
      'X-Upload-Content-Type': b.mimeType,
      'X-Upload-Content-Length': String(b.size),
      Origin: b.origin
    },
    muteHttpExceptions: true
  });
  var h = res.getHeaders();
  var out = res.getResponseCode() === 200
    ? { uploadUrl: h.Location || h.location }
    : { error: res.getResponseCode() + ' ' + res.getContentText() };
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

// Referencing DriveApp makes Apps Script request the Drive scope.
function forceDriveScope() { DriveApp.getRootFolder(); }
```

- [ ] **Step 2: Write the spike page**

`spike/index.html`:

```html
<!doctype html>
<meta charset="utf-8">
<title>CORS spike</title>
<input id="endpoint" placeholder="Apps Script /exec URL" size="80">
<input type="file" id="file">
<button id="go">Upload</button>
<pre id="log"></pre>
<script type="module">
  const log = (m) => (document.querySelector('#log').textContent += m + '\n');
  document.querySelector('#go').onclick = async () => {
    const file = document.querySelector('#file').files[0];
    const endpoint = document.querySelector('#endpoint').value.trim();
    const initRes = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ fileName: file.name, mimeType: file.type || 'application/octet-stream', size: file.size, origin: location.origin })
    });
    const { uploadUrl, error } = await initRes.json();
    log('init: ' + (uploadUrl ? 'ok' : error));
    if (!uploadUrl) return;
    const CHUNK = 8 * 1024 * 1024;
    let offset = 0;
    while (offset < file.size) {
      const end = Math.min(offset + CHUNK, file.size) - 1;
      const res = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Range': `bytes ${offset}-${end}/${file.size}` },
        body: file.slice(offset, end + 1)
      });
      log(`PUT ${offset}-${end}: status=${res.status} range=${res.headers.get('Range')}`);
      if (res.status === 200 || res.status === 201) { log('DONE'); return; }
      if (res.status !== 308) { log('UNEXPECTED'); return; }
      offset = end + 1;
    }
  };
</script>
```

- [ ] **Step 3: Deploy the spike script (human, in the developer's Google account)**

1. Open https://script.google.com → **New project** → paste `spike/Code.gs`.
2. **Deploy → New deployment → Web app**. Execute as: **Me**. Who has access: **Anyone**.
3. Authorize: **Advanced → Go to (project) (unsafe) → Allow**.
4. Copy the `/exec` URL.

- [ ] **Step 4: Run the spike locally**

Run: `npx --yes http-server spike -p 8080 -c-1`
Open `http://localhost:8080` in desktop Chrome, paste the `/exec` URL, pick a ~30 MB video and click Upload.
Expected log: `init: ok`, then `PUT ...: status=308 range=bytes=0-8388607`, and so on, ending in `DONE`. The file `spike_<name>` plays in the developer's Drive.

- [ ] **Step 5: Record the result and clean up**

- **Everything worked** → continue with the plan as written.
- **`range=null` but statuses are fine** → continue. The uploader (Task 4) treats no-progress 308s as failed attempts and re-queries status, so it stays correct. Note it in the task file.
- **The PUT fails with a CORS/network error** → STOP and report to the human. The contingency is to proxy each chunk through Apps Script (base64 body, `UrlFetchApp` PUT to the session). It's slower but works. It needs a plan revision for Tasks 4–5.

Delete `spike/` and the spike file in Drive. Archive the spike deployment (Deploy → Manage deployments → Archive).

---

### Task 2: Scaffold + pure helpers (`chunks.js`, `format.js`)

**Files:**
- Create: `package.json`, `.gitignore`, `web/lib/chunks.js`, `web/lib/format.js`
- Test: `tests/chunks.test.js`, `tests/format.test.js`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `CHUNK_SIZE: number` (8388608)
  - `chunkRange(offset: number, total: number, chunkSize?: number) → { start: number, end: number }` (end inclusive)
  - `contentRange(start: number, end: number, total: number) → string`
  - `statusContentRange(total: number) → string`
  - `parseRangeHeader(header: string | null) → number` (next byte offset; 0 when absent or invalid)
  - `backoffDelay(attempt: number, base?: number, max?: number) → number` (ms)
  - `LARGE_FILE_BYTES: number` (314572800)
  - `formatBytes(bytes: number) → string` (es-AR decimals, e.g. `"1,5 KB"`)
  - `isLargeFile(size: number) → boolean`
  - `resolveMimeType({ name: string, type: string }) → string`

- [ ] **Step 1: Create the scaffold**

`package.json`:

```json
{
  "name": "wedding-guest-upload",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test \"tests/**/*.test.js\""
  }
}
```

`.gitignore`:

```
node_modules/
spike/
.DS_Store
```

- [ ] **Step 2: Write the failing tests**

`tests/chunks.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHUNK_SIZE, chunkRange, contentRange, statusContentRange, parseRangeHeader, backoffDelay,
} from '../web/lib/chunks.js';

const MiB = 1024 * 1024;

test('CHUNK_SIZE is 8 MiB and a multiple of 256 KiB', () => {
  assert.equal(CHUNK_SIZE, 8 * MiB);
  assert.equal(CHUNK_SIZE % (256 * 1024), 0);
});

test('chunkRange returns a full chunk from the offset', () => {
  assert.deepEqual(chunkRange(0, 20 * MiB), { start: 0, end: 8 * MiB - 1 });
});

test('chunkRange clamps the last chunk to the file end', () => {
  assert.deepEqual(chunkRange(16 * MiB, 20 * MiB), { start: 16 * MiB, end: 20 * MiB - 1 });
  assert.deepEqual(chunkRange(8, 10, 4), { start: 8, end: 9 });
});

test('contentRange formats a byte range', () => {
  assert.equal(contentRange(0, 8388607, 20971520), 'bytes 0-8388607/20971520');
});

test('statusContentRange formats a status query', () => {
  assert.equal(statusContentRange(10), 'bytes */10');
});

test('parseRangeHeader returns the next offset', () => {
  assert.equal(parseRangeHeader('bytes=0-8388607'), 8388608);
});

test('parseRangeHeader returns 0 when missing or malformed', () => {
  assert.equal(parseRangeHeader(null), 0);
  assert.equal(parseRangeHeader(''), 0);
  assert.equal(parseRangeHeader('garbage'), 0);
});

test('backoffDelay doubles and caps', () => {
  assert.equal(backoffDelay(0), 1000);
  assert.equal(backoffDelay(1), 2000);
  assert.equal(backoffDelay(3), 8000);
  assert.equal(backoffDelay(10), 16000);
});
```

`tests/format.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LARGE_FILE_BYTES, formatBytes, isLargeFile, resolveMimeType } from '../web/lib/format.js';

const MiB = 1024 * 1024;

test('formatBytes uses the largest fitting unit with es-AR decimals', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1536), '1,5 KB');
  assert.equal(formatBytes(450 * MiB), '450 MB');
  assert.equal(formatBytes(1.5 * 1024 * MiB), '1,5 GB');
});

test('isLargeFile is true only above 300 MB', () => {
  assert.equal(LARGE_FILE_BYTES, 300 * MiB);
  assert.equal(isLargeFile(300 * MiB), false);
  assert.equal(isLargeFile(300 * MiB + 1), true);
});

test('resolveMimeType keeps a browser-provided type', () => {
  assert.equal(resolveMimeType({ name: 'a.jpg', type: 'image/jpeg' }), 'image/jpeg');
});

test('resolveMimeType infers from the extension when type is empty', () => {
  assert.equal(resolveMimeType({ name: 'IMG_1.HEIC', type: '' }), 'image/heic');
  assert.equal(resolveMimeType({ name: 'clip.mov', type: '' }), 'video/quicktime');
  assert.equal(resolveMimeType({ name: 'clip.mp4', type: '' }), 'video/mp4');
});

test('resolveMimeType falls back to octet-stream for unknown files', () => {
  assert.equal(resolveMimeType({ name: 'notes.txt', type: '' }), 'application/octet-stream');
  assert.equal(resolveMimeType({ name: 'noextension', type: '' }), 'application/octet-stream');
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `web/lib/chunks.js` and `web/lib/format.js`.

- [ ] **Step 4: Implement**

`web/lib/chunks.js`:

```js
// Drive requires every chunk except the last to be a multiple of 256 KiB.
export const CHUNK_SIZE = 8 * 1024 * 1024;

export function chunkRange(offset, total, chunkSize = CHUNK_SIZE) {
  return { start: offset, end: Math.min(offset + chunkSize, total) - 1 };
}

export function contentRange(start, end, total) {
  return `bytes ${start}-${end}/${total}`;
}

export function statusContentRange(total) {
  return `bytes */${total}`;
}

// Drive reports persisted bytes as "bytes=0-N"; the next offset is N + 1.
export function parseRangeHeader(header) {
  if (!header) return 0;
  const match = /bytes=0-(\d+)/.exec(header);
  return match ? Number(match[1]) + 1 : 0;
}

export function backoffDelay(attempt, base = 1000, max = 16000) {
  return Math.min(base * 2 ** attempt, max);
}
```

`web/lib/format.js`:

```js
export const LARGE_FILE_BYTES = 300 * 1024 * 1024;

const UNITS = ['B', 'KB', 'MB', 'GB'];

const MIME_BY_EXTENSION = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  mov: 'video/quicktime',
  '3gp': 'video/3gpp',
  webm: 'video/webm',
};

export function formatBytes(bytes) {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  const rounded = Math.round(value * 10) / 10;
  return `${rounded.toLocaleString('es-AR')} ${UNITS[unit]}`;
}

export function isLargeFile(size) {
  return size > LARGE_FILE_BYTES;
}

// Some Android browsers report an empty type for HEIC/MOV files.
export function resolveMimeType({ name, type }) {
  if (type) return type;
  const extension = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  return MIME_BY_EXTENSION[extension] ?? 'application/octet-stream';
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS (all tests in both files).

- [ ] **Step 6: Commit**

```bash
git add package.json .gitignore web/lib/chunks.js web/lib/format.js tests/chunks.test.js tests/format.test.js
git commit -m "feat: add chunk math and format helpers"
```

---

### Task 3: Init client (`api.js`)

**Files:**
- Create: `web/lib/api.js`
- Test: `tests/api.test.js`

**Interfaces:**
- Consumes: nothing
- Produces: `createInitClient({ endpoint: string, fetchImpl?: typeof fetch }) → init(payload: { fileName: string, mimeType: string, size: number, guestName?: string, origin?: string }) → Promise<{ ok: true, uploadUrl: string } | { ok: false, error: 'no_space' | 'invalid' | 'server' | 'network' }>`

- [ ] **Step 1: Write the failing test**

`tests/api.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInitClient } from '../web/lib/api.js';

const payload = { fileName: 'a.jpg', mimeType: 'image/jpeg', size: 10, guestName: 'Ana', origin: 'http://localhost:8080' };

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

test('init posts the payload as text/plain JSON with action init', async () => {
  const calls = [];
  const init = createInitClient({
    endpoint: 'https://script.example/exec',
    fetchImpl: async (url, options) => { calls.push({ url, options }); return jsonResponse({ ok: true, uploadUrl: 'https://up/1' }); },
  });
  const result = await init(payload);
  assert.deepEqual(result, { ok: true, uploadUrl: 'https://up/1' });
  assert.equal(calls[0].url, 'https://script.example/exec');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers['Content-Type'], 'text/plain;charset=utf-8');
  assert.deepEqual(JSON.parse(calls[0].options.body), { action: 'init', ...payload });
});

test('init passes through known server errors', async () => {
  const init = createInitClient({ endpoint: 'x', fetchImpl: async () => jsonResponse({ ok: false, error: 'no_space' }) });
  assert.deepEqual(await init(payload), { ok: false, error: 'no_space' });
});

test('init maps unknown bodies and non-2xx to server', async () => {
  const weird = createInitClient({ endpoint: 'x', fetchImpl: async () => jsonResponse({ hello: 1 }) });
  assert.deepEqual(await weird(payload), { ok: false, error: 'server' });
  const failing = createInitClient({ endpoint: 'x', fetchImpl: async () => jsonResponse({}, 500) });
  assert.deepEqual(await failing(payload), { ok: false, error: 'server' });
});

test('init maps thrown fetch errors to network', async () => {
  const init = createInitClient({ endpoint: 'x', fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
  assert.deepEqual(await init(payload), { ok: false, error: 'network' });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `web/lib/api.js`.

- [ ] **Step 3: Implement**

`web/lib/api.js`:

```js
const SERVER_ERRORS = ['no_space', 'invalid', 'server'];

// text/plain avoids a CORS preflight, which Apps Script web apps do not answer.
export function createInitClient({ endpoint, fetchImpl = (...args) => fetch(...args) }) {
  return async function init(payload) {
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action: 'init', ...payload }),
      });
    } catch {
      return { ok: false, error: 'network' };
    }
    if (!response.ok) return { ok: false, error: 'server' };
    try {
      const data = await response.json();
      if (data?.ok === true && typeof data.uploadUrl === 'string') {
        return { ok: true, uploadUrl: data.uploadUrl };
      }
      if (data?.ok === false && SERVER_ERRORS.includes(data.error)) {
        return { ok: false, error: data.error };
      }
    } catch {
      // Fall through: an unparseable body is a server problem.
    }
    return { ok: false, error: 'server' };
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/lib/api.js tests/api.test.js
git commit -m "feat: add init client for the upload contract"
```

---

### Task 4: Resumable upload engine (`uploader.js`)

**Files:**
- Create: `web/lib/uploader.js`
- Test: `tests/uploader.test.js`

**Interfaces:**
- Consumes: from `web/lib/chunks.js`: `CHUNK_SIZE`, `chunkRange`, `contentRange`, `statusContentRange`, `parseRangeHeader`, `backoffDelay`. `init` from Task 3's `createInitClient`.
- Produces: `uploadFile({ file: Blob & { name: string, size: number }, mimeType: string, guestName?: string, origin?: string, init, fetchImpl?, sleep?: (ms) => Promise<void>, onProgress?: (sent: number, total: number) => void, chunkSize?: number, maxAttempts?: number }) → Promise<{ ok: true } | { ok: false, error: 'no_space' | 'invalid' | 'server' | 'network' | 'rejected' | 'session_expired' }>`

Rules:
- `200/201` → done.
- `308` → offset = `parseRangeHeader(Range)`. If the offset did not advance past the previous one, count it as a failed attempt (prevents infinite loops).
- `404/410` → re-`init` once and restart from 0. A second expiry → `session_expired`.
- Other `4xx` except `408/429` → `rejected` immediately.
- Thrown error, `5xx`, `408`, `429` → attempt++. At `maxAttempts` → `network`. Otherwise sleep `backoffDelay(attempt - 1)`, then query status (`PUT`, `Content-Range: bytes */total`, empty body) and resume from the confirmed offset.

- [ ] **Step 1: Write the failing test**

`tests/uploader.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uploadFile } from '../web/lib/uploader.js';

function makeFile(size) {
  return new File([new Uint8Array(size)], 'clip.mp4', { type: 'video/mp4' });
}

function res(status, headers = {}) {
  return { status, headers: new Headers(headers) };
}

// Plays back scripted responses in order and records every request.
function scriptedFetch(steps) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, contentRange: options.headers['Content-Range'], bodySize: options.body ? options.body.size : 0 });
    const step = steps.shift();
    if (!step) throw new Error('unexpected extra request');
    if (step instanceof Error) throw step;
    return step;
  };
  return { fetchImpl, calls };
}

function okInit(urls = ['https://up/1']) {
  const calls = [];
  const init = async (payload) => { calls.push(payload); return { ok: true, uploadUrl: urls[calls.length - 1] ?? urls.at(-1) }; };
  return { init, calls };
}

const noSleep = async () => {};

test('uploads a single-chunk file', async () => {
  const { fetchImpl, calls } = scriptedFetch([res(200)]);
  const { init } = okInit();
  const result = await uploadFile({ file: makeFile(10), mimeType: 'video/mp4', init, fetchImpl, sleep: noSleep, chunkSize: 16 });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls.map((c) => c.contentRange), ['bytes 0-9/10']);
  assert.equal(calls[0].bodySize, 10);
});

test('uploads multiple chunks following the Range header', async () => {
  const { fetchImpl, calls } = scriptedFetch([
    res(308, { Range: 'bytes=0-3' }),
    res(308, { Range: 'bytes=0-7' }),
    res(201),
  ]);
  const progress = [];
  const result = await uploadFile({
    file: makeFile(10), mimeType: 'video/mp4', init: okInit().init, fetchImpl, sleep: noSleep, chunkSize: 4,
    onProgress: (sent, total) => progress.push([sent, total]),
  });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls.map((c) => c.contentRange), ['bytes 0-3/10', 'bytes 4-7/10', 'bytes 8-9/10']);
  assert.deepEqual(progress, [[4, 10], [8, 10], [10, 10]]);
});

test('passes file metadata to init', async () => {
  const { fetchImpl } = scriptedFetch([res(200)]);
  const { init, calls } = okInit();
  await uploadFile({ file: makeFile(10), mimeType: 'video/quicktime', guestName: 'Ana', origin: 'http://localhost:8080', init, fetchImpl, sleep: noSleep });
  assert.deepEqual(calls[0], { fileName: 'clip.mp4', mimeType: 'video/quicktime', size: 10, guestName: 'Ana', origin: 'http://localhost:8080' });
});

test('returns init errors without uploading', async () => {
  const { fetchImpl, calls } = scriptedFetch([]);
  const init = async () => ({ ok: false, error: 'no_space' });
  const result = await uploadFile({ file: makeFile(10), mimeType: 'video/mp4', init, fetchImpl, sleep: noSleep });
  assert.deepEqual(result, { ok: false, error: 'no_space' });
  assert.equal(calls.length, 0);
});

test('resumes from the server-confirmed offset after a network error', async () => {
  const sleeps = [];
  const { fetchImpl, calls } = scriptedFetch([
    res(308, { Range: 'bytes=0-3' }),
    new TypeError('network down'),
    res(308, { Range: 'bytes=0-5' }),
    res(200),
  ]);
  const result = await uploadFile({
    file: makeFile(10), mimeType: 'video/mp4', init: okInit().init, fetchImpl, chunkSize: 4,
    sleep: async (ms) => { sleeps.push(ms); },
  });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls.map((c) => c.contentRange), ['bytes 0-3/10', 'bytes 4-7/10', 'bytes */10', 'bytes 6-9/10']);
  assert.equal(calls[2].bodySize, 0);
  assert.deepEqual(sleeps, [1000]);
});

test('finishes when the status query reports the upload complete', async () => {
  const { fetchImpl } = scriptedFetch([new TypeError('lost response'), res(200)]);
  const result = await uploadFile({ file: makeFile(10), mimeType: 'video/mp4', init: okInit().init, fetchImpl, sleep: noSleep, chunkSize: 16 });
  assert.deepEqual(result, { ok: true });
});

test('gives up with network after maxAttempts', async () => {
  const failures = Array.from({ length: 20 }, () => new TypeError('offline'));
  const { fetchImpl } = scriptedFetch(failures);
  const result = await uploadFile({ file: makeFile(10), mimeType: 'video/mp4', init: okInit().init, fetchImpl, sleep: noSleep, maxAttempts: 3 });
  assert.deepEqual(result, { ok: false, error: 'network' });
});

test('treats 308 without progress as a failed attempt instead of looping', async () => {
  const stuck = Array.from({ length: 20 }, () => res(308));
  const { fetchImpl } = scriptedFetch(stuck);
  const result = await uploadFile({ file: makeFile(10), mimeType: 'video/mp4', init: okInit().init, fetchImpl, sleep: noSleep, chunkSize: 4, maxAttempts: 3 });
  assert.deepEqual(result, { ok: false, error: 'network' });
});

test('re-inits once and restarts when the session expires', async () => {
  const { fetchImpl, calls } = scriptedFetch([res(308, { Range: 'bytes=0-3' }), res(410), res(200)]);
  const { init, calls: initCalls } = okInit(['https://up/1', 'https://up/2']);
  const result = await uploadFile({ file: makeFile(10), mimeType: 'video/mp4', init, fetchImpl, sleep: noSleep, chunkSize: 4 });
  assert.deepEqual(result, { ok: true });
  assert.equal(initCalls.length, 2);
  assert.equal(calls[2].url, 'https://up/2');
  assert.equal(calls[2].contentRange, 'bytes 0-3/10');
});

test('reports session_expired after a second expiry', async () => {
  const { fetchImpl } = scriptedFetch([res(404), res(404)]);
  const result = await uploadFile({ file: makeFile(10), mimeType: 'video/mp4', init: okInit().init, fetchImpl, sleep: noSleep });
  assert.deepEqual(result, { ok: false, error: 'session_expired' });
});

test('rejects immediately on a non-retryable 4xx', async () => {
  const { fetchImpl, calls } = scriptedFetch([res(403)]);
  const result = await uploadFile({ file: makeFile(10), mimeType: 'video/mp4', init: okInit().init, fetchImpl, sleep: noSleep });
  assert.deepEqual(result, { ok: false, error: 'rejected' });
  assert.equal(calls.length, 1);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `web/lib/uploader.js`.

- [ ] **Step 3: Implement**

`web/lib/uploader.js`:

```js
import {
  CHUNK_SIZE, chunkRange, contentRange, statusContentRange, parseRangeHeader, backoffDelay,
} from './chunks.js';

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isDone = (status) => status === 200 || status === 201;
const isExpired = (status) => status === 404 || status === 410;
const isRetryable = (status) => status >= 500 || status === 408 || status === 429;

// Asks Drive how many bytes it has persisted. Returns 'done', an offset, or null if unknown.
async function queryOffset(fetchImpl, uploadUrl, total) {
  try {
    const res = await fetchImpl(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Range': statusContentRange(total) },
      body: null,
    });
    if (isDone(res.status)) return 'done';
    if (res.status === 308) return parseRangeHeader(res.headers.get('Range'));
  } catch {
    // Unknown; keep the current offset.
  }
  return null;
}

export async function uploadFile({
  file,
  mimeType,
  guestName,
  origin,
  init,
  fetchImpl = (...args) => fetch(...args),
  sleep = defaultSleep,
  onProgress = () => {},
  chunkSize = CHUNK_SIZE,
  maxAttempts = 5,
}) {
  const total = file.size;
  const openSession = () => init({ fileName: file.name, mimeType, size: total, guestName, origin });

  let session = await openSession();
  if (!session.ok) return session;

  let uploadUrl = session.uploadUrl;
  let offset = 0;
  let attempts = 0;
  let restarted = false;

  while (true) {
    const { start, end } = chunkRange(offset, total, chunkSize);
    let res = null;
    try {
      res = await fetchImpl(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Range': contentRange(start, end, total) },
        body: file.slice(start, end + 1),
      });
    } catch {
      res = null;
    }

    if (res && isDone(res.status)) {
      onProgress(total, total);
      return { ok: true };
    }

    if (res && res.status === 308) {
      const next = parseRangeHeader(res.headers.get('Range'));
      if (next > offset) {
        offset = next;
        attempts = 0;
        onProgress(offset, total);
        continue;
      }
      // No progress: fall through and treat it as a failed attempt.
    } else if (res && isExpired(res.status)) {
      if (restarted) return { ok: false, error: 'session_expired' };
      restarted = true;
      session = await openSession();
      if (!session.ok) return session;
      uploadUrl = session.uploadUrl;
      offset = 0;
      attempts = 0;
      onProgress(0, total);
      continue;
    } else if (res && !isRetryable(res.status)) {
      return { ok: false, error: 'rejected' };
    }

    attempts++;
    if (attempts >= maxAttempts) return { ok: false, error: 'network' };
    await sleep(backoffDelay(attempts - 1));

    const confirmed = await queryOffset(fetchImpl, uploadUrl, total);
    if (confirmed === 'done') {
      onProgress(total, total);
      return { ok: true };
    }
    if (confirmed !== null) {
      offset = confirmed;
      onProgress(offset, total);
    }
  }
}
```

Note: the 'treats 308 without progress' test runs with `maxAttempts: 3`. Each attempt consumes one chunk PUT and one status query, so the 20 scripted responses are enough.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS (all uploader tests plus the earlier tasks).

- [ ] **Step 5: Commit**

```bash
git add web/lib/uploader.js tests/uploader.test.js
git commit -m "feat: add resumable chunked upload engine with retry and resume"
```

---

### Task 5: Apps Script `init` endpoint

**Files:**
- Create: `apps-script/Code.gs`, `apps-script/appsscript.json`
- Test: `tests/apps-script.test.js`

**Interfaces:**
- Consumes: the contract from Global Constraints.
- Produces (global functions in `Code.gs`): `doGet()`, `doPost(e)`, `handleInit(body)`, `isValidInit(body)`, `hasSpaceFor(size)`, `slugify(value)`, `sanitizeFileName(value)`, `buildFileName(date, guestName, fileName)`, `resolveOrigin(requested)`, `getFolderId()`, `createUploadSession({ name, folderId, mimeType, size, origin })`.

- [ ] **Step 1: Write the failing test**

`tests/apps-script.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8');

// Values created inside the vm realm have different prototypes; normalize before deepEqual.
const plain = (value) => JSON.parse(JSON.stringify(value));

function load({
  limit = 100 * 1024 ** 3,
  used = 0,
  sessionCode = 200,
  sessionHeaders = { Location: 'https://upload.example/session-1' },
  folders = {},
  propertyReads = null,
  props = {},
  storageThrows = false,
} = {}) {
  const calls = { fetch: [], createdFolders: [], locks: 0 };
  const store = { ...props };
  const reads = propertyReads ? [...propertyReads] : null;
  const ctx = vm.createContext({
    console: { error() {}, log() {} },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: (text) => ({ text, setMimeType() { return this; } }),
    },
    DriveApp: {
      getStorageLimit: () => { if (storageThrows) throw new Error('boom'); return limit; },
      getStorageUsed: () => used,
      getFolderById: (id) => {
        if (!(id in folders)) throw new Error('not found');
        return { isTrashed: () => folders[id] === 'trashed' };
      },
      createFolder: (name) => { calls.createdFolders.push(name); return { getId: () => 'new-folder-id' }; },
    },
    PropertiesService: {
      getUserProperties: () => ({
        getProperty: (key) => (reads ? reads.shift() ?? null : store[key] ?? null),
        setProperty: (key, value) => { store[key] = value; },
      }),
    },
    LockService: { getScriptLock: () => ({ waitLock: () => { calls.locks++; }, releaseLock() {} }) },
    ScriptApp: { getOAuthToken: () => 'token-123' },
    UrlFetchApp: {
      fetch: (url, options) => {
        calls.fetch.push({ url, options });
        return { getResponseCode: () => sessionCode, getHeaders: () => sessionHeaders, getContentText: () => '' };
      },
    },
    Utilities: { formatDate: () => '2026-10-02_22-15-03' },
  });
  vm.runInContext(source, ctx);
  return { gs: ctx, calls, store };
}

const validBody = {
  action: 'init', fileName: 'IMG_1234.jpg', mimeType: 'image/jpeg', size: 1024, guestName: 'Tío Carlos', origin: 'https://iecargnino.github.io',
};

function post(gs, body) {
  const contents = typeof body === 'string' ? body : JSON.stringify(body);
  return JSON.parse(gs.doPost({ postData: { contents } }).text);
}

test('doGet reports the service is alive', () => {
  const { gs } = load();
  assert.deepEqual(JSON.parse(gs.doGet().text), { ok: true, service: 'wedding-upload' });
});

test('doPost returns an upload URL for a valid request', () => {
  const { gs, calls } = load();
  assert.deepEqual(post(gs, validBody), { ok: true, uploadUrl: 'https://upload.example/session-1' });
  const { url, options } = calls.fetch[0];
  assert.match(url, /uploadType=resumable/);
  assert.equal(options.method, 'post');
  assert.equal(options.headers.Authorization, 'Bearer token-123');
  assert.equal(options.headers['X-Upload-Content-Type'], 'image/jpeg');
  assert.equal(options.headers['X-Upload-Content-Length'], '1024');
  assert.equal(options.headers.Origin, 'https://iecargnino.github.io');
  assert.deepEqual(JSON.parse(options.payload), {
    name: '2026-10-02_22-15-03_Tio-Carlos_IMG_1234.jpg',
    parents: ['new-folder-id'],
  });
});

test('reads a lowercase location header', () => {
  const { gs } = load({ sessionHeaders: { location: 'https://upload.example/lower' } });
  assert.equal(post(gs, validBody).uploadUrl, 'https://upload.example/lower');
});

test('rejects malformed JSON and invalid bodies as invalid', () => {
  const { gs } = load();
  assert.deepEqual(post(gs, '{not json'), { ok: false, error: 'invalid' });
  assert.deepEqual(post(gs, { ...validBody, action: 'other' }), { ok: false, error: 'invalid' });
  assert.deepEqual(post(gs, { ...validBody, mimeType: 'application/pdf' }), { ok: false, error: 'invalid' });
  assert.deepEqual(post(gs, { ...validBody, mimeType: 'application/octet-stream' }), { ok: false, error: 'invalid' });
  assert.deepEqual(post(gs, { ...validBody, size: 0 }), { ok: false, error: 'invalid' });
  assert.deepEqual(post(gs, { ...validBody, size: 1.5 }), { ok: false, error: 'invalid' });
  assert.deepEqual(post(gs, { ...validBody, fileName: '   ' }), { ok: false, error: 'invalid' });
  assert.deepEqual(post(gs, { ...validBody, guestName: 42 }), { ok: false, error: 'invalid' });
});

test('accepts a missing guest name', () => {
  const { gs, calls } = load();
  const { guestName, ...body } = validBody;
  assert.equal(post(gs, body).ok, true);
  assert.equal(JSON.parse(calls.fetch[0].options.payload).name, '2026-10-02_22-15-03_Invitado_IMG_1234.jpg');
});

test('returns no_space when the file does not fit', () => {
  const { gs, calls } = load({ limit: 2000, used: 1500 });
  assert.deepEqual(post(gs, validBody), { ok: false, error: 'no_space' });
  assert.equal(calls.fetch.length, 0);
});

test('treats a non-positive storage limit as unlimited', () => {
  const { gs } = load({ limit: -1, used: 999999 });
  assert.equal(post(gs, validBody).ok, true);
});

test('returns server when Drive refuses the session', () => {
  const { gs } = load({ sessionCode: 403 });
  assert.deepEqual(post(gs, validBody), { ok: false, error: 'server' });
});

test('returns server when an unexpected exception occurs', () => {
  const { gs } = load({ storageThrows: true });
  assert.deepEqual(post(gs, validBody), { ok: false, error: 'server' });
});

test('resolveOrigin allows localhost and falls back to GitHub Pages', () => {
  const { gs } = load();
  assert.equal(gs.resolveOrigin('http://localhost:8080'), 'http://localhost:8080');
  assert.equal(gs.resolveOrigin('https://evil.example'), 'https://iecargnino.github.io');
  assert.equal(gs.resolveOrigin(undefined), 'https://iecargnino.github.io');
});

test('slugify keeps names readable and safe', () => {
  const { gs } = load();
  assert.equal(gs.slugify('Tío Carlos 🎉'), 'Tio-Carlos');
  assert.equal(gs.slugify('../../etc'), 'etc');
  assert.equal(gs.slugify(''), 'Invitado');
  assert.equal(gs.slugify(null), 'Invitado');
  assert.equal(gs.slugify('🎉🎉'), 'Invitado');
  assert.equal(gs.slugify('a'.repeat(60)).length, 40);
});

test('sanitizeFileName removes path separators and keeps the extension', () => {
  const { gs } = load();
  assert.equal(gs.sanitizeFileName('a/b\\c.jpg'), 'a_b_c.jpg');
  const long = gs.sanitizeFileName('x'.repeat(200) + '.mp4');
  assert.equal(long.length, 120);
  assert.ok(long.endsWith('.mp4'));
});

test('reuses an existing folder', () => {
  const { gs, calls } = load({ props: { FOLDER_ID: 'f1' }, folders: { f1: 'ok' } });
  post(gs, validBody);
  assert.deepEqual(plain(JSON.parse(calls.fetch[0].options.payload).parents), ['f1']);
  assert.equal(calls.createdFolders.length, 0);
});

test('recreates the folder when the stored one is trashed or missing', () => {
  const trashed = load({ props: { FOLDER_ID: 'f1' }, folders: { f1: 'trashed' } });
  post(trashed.gs, validBody);
  assert.deepEqual(trashed.calls.createdFolders, ['Casamiento Jesús & Dana']);
  assert.equal(trashed.store.FOLDER_ID, 'new-folder-id');

  const missing = load({ props: { FOLDER_ID: 'gone' } });
  post(missing.gs, validBody);
  assert.equal(missing.calls.createdFolders.length, 1);
});

test('double-checks the folder inside the lock so concurrent first uploads create one folder', () => {
  // First read (outside the lock) sees nothing; the second (inside) sees a folder another request created.
  const { gs, calls } = load({ propertyReads: [null, 'f2'], folders: { f2: 'ok' } });
  post(gs, validBody);
  assert.equal(calls.locks, 1);
  assert.equal(calls.createdFolders.length, 0);
  assert.deepEqual(plain(JSON.parse(calls.fetch[0].options.payload).parents), ['f2']);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL with `ENOENT` for `apps-script/Code.gs`.

- [ ] **Step 3: Implement**

`apps-script/Code.gs`:

```js
/* global ContentService, DriveApp, LockService, PropertiesService, ScriptApp, UrlFetchApp, Utilities */

var FOLDER_NAME = 'Casamiento Jesús & Dana';
var FOLDER_PROPERTY = 'FOLDER_ID';
var TIMEZONE = 'America/Argentina/Buenos_Aires';
// First entry is the production guest page origin; the rest are for local testing.
var ALLOWED_ORIGINS = ['https://iecargnino.github.io', 'http://localhost:8080'];
var DRIVE_UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id';

function doGet() {
  return jsonOutput({ ok: true, service: 'wedding-upload' });
}

function doPost(e) {
  var body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonOutput({ ok: false, error: 'invalid' });
  }
  try {
    return jsonOutput(handleInit(body));
  } catch (err) {
    console.error(err);
    return jsonOutput({ ok: false, error: 'server' });
  }
}

function jsonOutput(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}

function handleInit(body) {
  if (!isValidInit(body)) return { ok: false, error: 'invalid' };
  if (!hasSpaceFor(body.size)) return { ok: false, error: 'no_space' };
  var uploadUrl = createUploadSession({
    name: buildFileName(new Date(), body.guestName, body.fileName),
    folderId: getFolderId(),
    mimeType: body.mimeType,
    size: body.size,
    origin: resolveOrigin(body.origin)
  });
  return uploadUrl ? { ok: true, uploadUrl: uploadUrl } : { ok: false, error: 'server' };
}

function isValidInit(body) {
  return !!body && body.action === 'init' &&
    typeof body.fileName === 'string' && body.fileName.trim().length > 0 &&
    typeof body.mimeType === 'string' && /^(image|video)\//.test(body.mimeType) &&
    typeof body.size === 'number' && Number.isInteger(body.size) && body.size > 0 &&
    (body.guestName === undefined || body.guestName === null || typeof body.guestName === 'string');
}

function hasSpaceFor(size) {
  var limit = DriveApp.getStorageLimit();
  if (!(limit > 0)) return true; // Unlimited or unknown quota.
  return size <= limit - DriveApp.getStorageUsed();
}

function slugify(value) {
  var slug = String(value || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return slug || 'Invitado';
}

function sanitizeFileName(value) {
  // Keep the tail so the extension survives truncation.
  return String(value).replace(/[\/\\\u0000-\u001f]/g, '_').trim().slice(-120);
}

function buildFileName(date, guestName, fileName) {
  return Utilities.formatDate(date, TIMEZONE, 'yyyy-MM-dd_HH-mm-ss') + '_' + slugify(guestName) + '_' + sanitizeFileName(fileName);
}

function resolveOrigin(requested) {
  return ALLOWED_ORIGINS.indexOf(requested) >= 0 ? requested : ALLOWED_ORIGINS[0];
}

function getFolderId() {
  var props = PropertiesService.getUserProperties();
  var existing = findFolder(props.getProperty(FOLDER_PROPERTY));
  if (existing) return existing;

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    // Another request may have created the folder while we waited for the lock.
    existing = findFolder(props.getProperty(FOLDER_PROPERTY));
    if (existing) return existing;
    var id = DriveApp.createFolder(FOLDER_NAME).getId();
    props.setProperty(FOLDER_PROPERTY, id);
    return id;
  } finally {
    lock.releaseLock();
  }
}

function findFolder(id) {
  if (!id) return null;
  try {
    return DriveApp.getFolderById(id).isTrashed() ? null : id;
  } catch (err) {
    return null;
  }
}

// The Origin header makes Drive answer the browser's cross-origin chunk PUTs with CORS headers.
function createUploadSession(opts) {
  var response = UrlFetchApp.fetch(DRIVE_UPLOAD_URL, {
    method: 'post',
    contentType: 'application/json; charset=UTF-8',
    payload: JSON.stringify({ name: opts.name, parents: [opts.folderId] }),
    headers: {
      Authorization: 'Bearer ' + ScriptApp.getOAuthToken(),
      'X-Upload-Content-Type': opts.mimeType,
      'X-Upload-Content-Length': String(opts.size),
      Origin: opts.origin
    },
    muteHttpExceptions: true
  });
  if (response.getResponseCode() !== 200) {
    console.error('Drive session failed: ' + response.getResponseCode() + ' ' + response.getContentText());
    return null;
  }
  var headers = response.getHeaders();
  return headers.Location || headers.location || null;
}
```

`apps-script/appsscript.json`:

```json
{
  "timeZone": "America/Argentina/Buenos_Aires",
  "dependencies": {},
  "exceptionLogging": "STACKDRIVER",
  "runtimeVersion": "V8",
  "oauthScopes": [
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/script.external_request"
  ],
  "webapp": {
    "executeAs": "USER_DEPLOYING",
    "access": "ANYONE_ANONYMOUS"
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS (all suites).

- [ ] **Step 5: Commit**

```bash
git add apps-script/Code.gs apps-script/appsscript.json tests/apps-script.test.js
git commit -m "feat: add Apps Script init endpoint for resumable Drive sessions"
```

---

### Task 6: Guest page UI

**Files:**
- Create: `web/index.html`, `web/styles.css`, `web/config.js`, `web/app.js`

**Interfaces:**
- Consumes: `createInitClient` (Task 3), `uploadFile` (Task 4), `formatBytes`, `isLargeFile`, `resolveMimeType` (Task 2).
- Produces: the published page. `config.js` exports `COUPLE_NAMES: string`, `INIT_ENDPOINT: string`.

DOM wiring has no unit tests. It is covered by the manual checks in Step 3 and Task 7.

- [ ] **Step 1: Write the page**

`web/config.js`:

```js
export const COUPLE_NAMES = 'Jesús & Dana';

// Apps Script web app URL ending in /exec. Swapped to Dana's deployment at handoff.
export const INIT_ENDPOINT = 'https://script.google.com/macros/s/DEPLOYMENT_ID/exec';
```

`web/index.html`:

```html
<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>Fotos del casamiento</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <main class="page">
    <header class="hero">
      <p class="eyebrow">Casamiento</p>
      <h1 id="couple">Jesús &amp; Dana</h1>
      <p class="lead">Compartí tus fotos y videos de la fiesta. Van directo al álbum de los novios.</p>
    </header>

    <label class="field">
      <span>Tu nombre (opcional)</span>
      <input id="guest-name" type="text" autocomplete="name" maxlength="60" placeholder="Ej: Tía Marta">
    </label>

    <label class="picker">
      <input id="picker" type="file" multiple accept="image/*,video/*">
      <span>Elegir fotos y videos</span>
    </label>

    <p id="notice" class="notice" hidden>Subiendo… no cierres esta pantalla ni bloquees el celular.</p>

    <ul id="list" class="list" aria-live="polite"></ul>
  </main>
  <script type="module" src="app.js"></script>
</body>
</html>
```

`web/styles.css`:

```css
:root {
  --bg: #fbf8f4;
  --surface: #ffffff;
  --text: #2b2622;
  --muted: #7a7068;
  --accent: #8a6d4b;
  --accent-text: #ffffff;
  --ok: #3f7d4e;
  --error: #b3432f;
  --border: #e8e1d8;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}

.page {
  max-width: 480px;
  margin: 0 auto;
  padding: 32px 16px 48px;
}

.hero { text-align: center; margin-bottom: 28px; }
.eyebrow { margin: 0; color: var(--muted); letter-spacing: .15em; text-transform: uppercase; font-size: 13px; }
.hero h1 { margin: 4px 0 8px; font: 400 40px/1.1 Georgia, "Times New Roman", serif; }
.lead { margin: 0; color: var(--muted); }

.field { display: block; margin-bottom: 16px; }
.field span { display: block; font-size: 14px; color: var(--muted); margin-bottom: 6px; }
.field input {
  width: 100%;
  padding: 12px 14px;
  font-size: 16px; /* prevents iOS zoom on focus */
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface);
  color: var(--text);
}

.picker { display: block; cursor: pointer; }
.picker input { position: absolute; width: 1px; height: 1px; opacity: 0; }
.picker span {
  display: block;
  padding: 18px;
  text-align: center;
  font-size: 18px;
  font-weight: 600;
  border-radius: 12px;
  background: var(--accent);
  color: var(--accent-text);
}
.picker input:focus-visible + span { outline: 3px solid var(--text); outline-offset: 2px; }

.notice {
  margin: 16px 0 0;
  padding: 12px 14px;
  border-radius: 10px;
  background: #fff4e0;
  font-size: 14px;
}

.list { list-style: none; margin: 20px 0 0; padding: 0; display: grid; gap: 10px; }

.item {
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface);
}
.item-head { display: flex; justify-content: space-between; gap: 12px; font-size: 14px; }
.item-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.item-size { color: var(--muted); flex-shrink: 0; }
.item progress { width: 100%; height: 6px; margin: 8px 0 4px; accent-color: var(--accent); }
.item-status { font-size: 13px; color: var(--muted); }
.item.done .item-status { color: var(--ok); }
.item.error .item-status { color: var(--error); }
.item button {
  margin-top: 8px;
  padding: 8px 14px;
  font-size: 14px;
  border: 1px solid var(--accent);
  border-radius: 8px;
  background: transparent;
  color: var(--accent);
}
```

`web/app.js`:

```js
import { COUPLE_NAMES, INIT_ENDPOINT } from './config.js';
import { createInitClient } from './lib/api.js';
import { uploadFile } from './lib/uploader.js';
import { formatBytes, isLargeFile, resolveMimeType } from './lib/format.js';

const ERROR_MESSAGES = {
  no_space: 'Se llenó el espacio del álbum. Avisales a los novios.',
  invalid: 'Este archivo no es una foto o un video.',
  rejected: 'Google Drive rechazó el archivo.',
  session_expired: 'La subida se venció. Tocá Reintentar.',
  network: 'Problema de conexión. Tocá Reintentar.',
  server: 'Hubo un error en el servidor. Tocá Reintentar.',
};

const GUEST_NAME_KEY = 'guestName';

const els = {
  couple: document.querySelector('#couple'),
  guestName: document.querySelector('#guest-name'),
  picker: document.querySelector('#picker'),
  notice: document.querySelector('#notice'),
  list: document.querySelector('#list'),
};

const init = createInitClient({ endpoint: INIT_ENDPOINT });
let queue = Promise.resolve();
let pending = 0;
let wakeLock = null;

els.couple.textContent = COUPLE_NAMES;
els.guestName.value = readGuestName();
els.guestName.addEventListener('change', () => writeGuestName(els.guestName.value.trim()));
els.picker.addEventListener('change', onFilesChosen);
window.addEventListener('beforeunload', (event) => {
  if (pending > 0) event.preventDefault();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && pending > 0) acquireWakeLock();
});

function readGuestName() {
  try { return localStorage.getItem(GUEST_NAME_KEY) ?? ''; } catch { return ''; }
}

function writeGuestName(value) {
  try { localStorage.setItem(GUEST_NAME_KEY, value); } catch { /* storage unavailable */ }
}

function onFilesChosen() {
  for (const file of els.picker.files) {
    if (file.size === 0) continue;
    if (isLargeFile(file.size) && !confirmLarge(file)) continue;
    enqueue(file, createRow(file));
  }
  els.picker.value = '';
}

function confirmLarge(file) {
  return window.confirm(
    `Este video pesa ${formatBytes(file.size)}. Puede tardar varios minutos: ` +
    'mantené la pantalla abierta y, si podés, usá WiFi. ¿Subirlo igual?',
  );
}

function enqueue(file, row) {
  pending++;
  updateBusy();
  setRow(row, { state: 'queued', status: 'En espera…', sent: 0, total: file.size });
  queue = queue.then(() => runUpload(file, row));
}

async function runUpload(file, row) {
  setRow(row, { state: 'uploading', status: 'Subiendo…' });
  const result = await uploadFile({
    file,
    mimeType: resolveMimeType(file),
    guestName: els.guestName.value.trim(),
    origin: location.origin,
    init,
    onProgress: (sent, total) => setRow(row, { sent, total }),
  });
  if (result.ok) {
    setRow(row, { state: 'done', status: '¡Listo! Gracias ♥' });
  } else {
    setRow(row, { state: 'error', status: ERROR_MESSAGES[result.error] ?? ERROR_MESSAGES.server });
    if (result.error !== 'invalid' && result.error !== 'no_space') addRetry(file, row);
  }
  pending--;
  updateBusy();
}

function createRow(file) {
  const row = document.createElement('li');
  row.className = 'item';
  row.innerHTML = `
    <div class="item-head"><span class="item-name"></span><span class="item-size"></span></div>
    <progress max="1" value="0"></progress>
    <div class="item-status"></div>`;
  row.querySelector('.item-name').textContent = file.name;
  row.querySelector('.item-size').textContent = formatBytes(file.size);
  els.list.prepend(row);
  return row;
}

function setRow(row, { state, status, sent, total }) {
  if (state) row.className = `item ${state}`;
  if (status) row.querySelector('.item-status').textContent = status;
  if (sent !== undefined && total) row.querySelector('progress').value = sent / total;
}

function addRetry(file, row) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Reintentar';
  button.addEventListener('click', () => {
    button.remove();
    enqueue(file, row);
  });
  row.append(button);
}

function updateBusy() {
  els.notice.hidden = pending === 0;
  if (pending > 0) acquireWakeLock();
  else releaseWakeLock();
}

async function acquireWakeLock() {
  if (wakeLock || !('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch {
    wakeLock = null; // Not allowed (e.g. low battery); the notice still warns the guest.
  }
}

function releaseWakeLock() {
  wakeLock?.release();
  wakeLock = null;
}
```

- [ ] **Step 2: Run the unit tests (regression)**

Run: `npm test`
Expected: PASS.

- [ ] **Step 3: Local UI smoke test (no backend)**

Run: `npx --yes http-server web -p 8080 -c-1`, then open `http://localhost:8080` in desktop Chrome with DevTools in mobile emulation.
Expected:
- Header "Jesús & Dana", name field and button render with no horizontal scroll at 360px width.
- Picking a photo shows a row. Because `DEPLOYMENT_ID` isn't real yet, it ends in "Problema de conexión" or "Hubo un error en el servidor" with a **Reintentar** button, and no console errors besides the failed request.
- The name persists after a reload.

- [ ] **Step 4: Commit**

```bash
git add web/index.html web/styles.css web/config.js web/app.js
git commit -m "feat: add mobile guest upload page"
```

---

### Task 7: Deploy (developer account) and device E2E

**Files:**
- Create: `.github/workflows/pages.yml`
- Modify: `web/config.js` (real `INIT_ENDPOINT`)

**Interfaces:**
- Consumes: everything above.
- Produces: the production guest page URL `https://iecargnino.github.io/<repo>/` and the developer's `/exec` URL.

- [ ] **Step 1: Deploy Apps Script in the developer's account (human)**

1. https://script.google.com → **New project**, named `Wedding upload`.
2. Paste `apps-script/Code.gs` into `Code.gs`.
3. **Project Settings → Show "appsscript.json" manifest file in editor**, then paste `apps-script/appsscript.json`.
4. **Deploy → New deployment → Web app**. Execute as: **Me**. Who has access: **Anyone** → Deploy → authorize (Advanced → Go to Wedding upload → Allow).
5. Copy the `/exec` URL. Opening it in a browser must show `{"ok":true,"service":"wedding-upload"}`.

- [ ] **Step 2: Point the page at the deployment and run a local E2E**

Set `INIT_ENDPOINT` in `web/config.js` to the `/exec` URL.
Run: `npx --yes http-server web -p 8080 -c-1`, open `http://localhost:8080`, and upload one photo and one ~30 MB video.
Expected: both rows reach "¡Listo! Gracias ♥". The folder `Casamiento Jesús & Dana` appears in the developer's Drive with `YYYY-MM-DD_HH-mm-ss_<Name>_<file>` names, and the video plays.

- [ ] **Step 3: Add the Pages workflow**

`.github/workflows/pages.yml`:

```yaml
name: Deploy guest page

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: true

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - run: npm test
      - uses: actions/configure-pages@v5
      - uses: actions/upload-pages-artifact@v3
        with:
          path: web
      - id: deployment
        uses: actions/deploy-pages@v4
```

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/pages.yml web/config.js
git commit -m "ci: deploy guest page to GitHub Pages"
```

- [ ] **Step 5: Create the public repo and enable Pages (ask the human first: this publishes the repo)**

```bash
gh repo create iecargnino/boda-jesus-dana --public --source . --push
gh api -X POST repos/iecargnino/boda-jesus-dana/pages -f build_type=workflow
gh run watch --repo iecargnino/boda-jesus-dana
```

Expected: the workflow succeeds and `https://iecargnino.github.io/boda-jesus-dana/` loads the page.

- [ ] **Step 6: Device E2E (human with real phones)**

For each of **iPhone Safari** and **Android Chrome**, on **Wi-Fi** and on **mobile data**:
- Upload a batch of 5 photos. All reach "¡Listo!".
- Upload one video > 300 MB. The confirm dialog appears; after accepting, it completes and plays in Drive.
- Toggle airplane mode for about 10s mid-video. The upload resumes on its own or ends in **Reintentar**, and retrying completes it.
- Try to close the tab mid-upload. The browser asks for confirmation (desktop/Android; iOS may not show it).
- The screen does not auto-lock while uploading (where Wake Lock is supported).

Record results per device in `odd/tasks/wedding-guest-upload.md`. Fix any failures before Task 8 and add a regression test when the failure is in `web/lib/` or `Code.gs`.

---

### Task 8: Handoff guide for Dana and the final QR

**Files:**
- Create: `docs/handoff-dana.md`, `qr/qr-boda.png`
- Modify: `web/config.js` (Dana's `INIT_ENDPOINT`)

**Interfaces:**
- Consumes: the tested deployment flow from Task 7.
- Produces: Dana's deployment live behind the unchanged page URL, and a printable QR.

- [ ] **Step 1: Write the guide (Spanish, neutral register; audience: Dana, non-technical)**

`docs/handoff-dana.md`:

````markdown
# Activar el álbum de fotos del casamiento (5 minutos)

Esto conecta la página de fotos con tu Google Drive. Las fotos y videos de los invitados
se guardan en tu cuenta, en la carpeta **"Casamiento Jesús & Dana"**.

## Pasos

1. Entrá a https://script.google.com con tu cuenta de Google y tocá **Nuevo proyecto**.
2. Arriba a la izquierda, cambiá el nombre "Proyecto sin título" por **Álbum casamiento**.
3. Borrá todo el texto del editor y pegá el código que te pasamos (archivo `Code.gs`).
4. Tocá el engranaje **Configuración del proyecto** y activá
   **Mostrar el archivo de manifiesto "appsscript.json" en el editor**.
5. Volvé al editor (ícono `< >`), abrí `appsscript.json`, borrá su contenido y pegá el
   segundo texto que te pasamos.
6. Tocá **Implementar → Nueva implementación**. En el engranaje de "Seleccionar tipo",
   elegí **Aplicación web**.
   - Ejecutar como: **Yo**
   - Quién tiene acceso: **Cualquier usuario**
7. Tocá **Implementar** y después **Autorizar acceso**. Elegí tu cuenta.
8. Google va a mostrar **"Google no verificó esta app"**. Es normal: la app la creaste vos
   y solo accede a tu Drive. Tocá **Configuración avanzada** → **Ir a Álbum casamiento (no seguro)**
   → **Permitir**.
9. Copiá la **URL de la aplicación web** (termina en `/exec`) y mandánosla.

Listo. Nosotros conectamos la página y hacemos una prueba final.

## Preguntas frecuentes

- **¿Pueden ver mi Drive los invitados?** No. Solo pueden subir archivos; no ven nada.
- **¿Dónde quedan las fotos?** En la carpeta "Casamiento Jesús & Dana" de tu Drive.
- **¿Cómo lo desactivo después?** En script.google.com → Álbum casamiento →
  Implementar → Gestionar implementaciones → Archivar.
````

- [ ] **Step 2: Send Dana the guide plus `apps-script/Code.gs` and `apps-script/appsscript.json` (human)**

- [ ] **Step 3: Switch the endpoint to Dana's deployment**

Set `INIT_ENDPOINT` in `web/config.js` to Dana's `/exec` URL.

```bash
git add web/config.js docs/handoff-dana.md
git commit -m "chore: point guest page to the couple's deployment"
git push
```

Expected: Pages redeploys. Opening Dana's `/exec` URL shows `{"ok":true,"service":"wedding-upload"}`.

- [ ] **Step 4: Final verification upload**

Upload one photo from a phone through the production page URL.
Expected: it appears in **Dana's** Drive in `Casamiento Jesús & Dana` (she confirms), and nothing new appears in the developer's Drive.

- [ ] **Step 5: Generate the QR**

Run: `npx --yes qrcode -o qr/qr-boda.png -w 1200 -e H "https://iecargnino.github.io/boda-jesus-dana/"`
Expected: `qr/qr-boda.png` exists. Scanning it with both phones opens the page.

```bash
git add qr/qr-boda.png
git commit -m "chore: add printable QR for the guest page"
git push
```

- [ ] **Step 6: Archive the developer's test deployment (human)**

script.google.com → Wedding upload → Deploy → Manage deployments → Archive. Optionally delete the developer's test folder in Drive.
