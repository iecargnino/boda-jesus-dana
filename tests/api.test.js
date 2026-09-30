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
