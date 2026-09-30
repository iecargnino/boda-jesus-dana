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
