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
    calls.push({ url, contentRange: options.headers['Content-Range'], bodySize: options.body ? options.body.size : 0, signal: options.signal });
    const step = steps.shift();
    if (!step) throw new Error('unexpected extra request');
    if (step instanceof Error) throw step;
    if (typeof step === 'function') return step();
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

test('returns cancelled without calling init when already aborted', async () => {
  const controller = new AbortController();
  controller.abort();
  const { fetchImpl, calls } = scriptedFetch([]);
  const { init, calls: initCalls } = okInit();
  const result = await uploadFile({ file: makeFile(10), mimeType: 'video/mp4', init, fetchImpl, sleep: noSleep, signal: controller.signal });
  assert.deepEqual(result, { ok: false, error: 'cancelled' });
  assert.equal(initCalls.length, 0);
  assert.equal(calls.length, 0);
});

test('aborts mid-upload and makes no further requests', async () => {
  const controller = new AbortController();
  const { fetchImpl, calls } = scriptedFetch([
    res(308, { Range: 'bytes=0-3' }),
    () => { controller.abort(); throw new DOMException('aborted', 'AbortError'); },
  ]);
  const result = await uploadFile({
    file: makeFile(10), mimeType: 'video/mp4', init: okInit().init, fetchImpl, sleep: noSleep, chunkSize: 4, signal: controller.signal,
  });
  assert.deepEqual(result, { ok: false, error: 'cancelled' });
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => c.contentRange !== 'bytes */10'));
});

test('stops during backoff without querying status', async () => {
  const controller = new AbortController();
  const { fetchImpl, calls } = scriptedFetch([new TypeError('network down')]);
  const result = await uploadFile({
    file: makeFile(10), mimeType: 'video/mp4', init: okInit().init, fetchImpl, chunkSize: 4, signal: controller.signal,
    sleep: async () => { controller.abort(); },
  });
  assert.deepEqual(result, { ok: false, error: 'cancelled' });
  assert.equal(calls.length, 1);
});

test('passes the signal to fetch', async () => {
  const controller = new AbortController();
  const { fetchImpl, calls } = scriptedFetch([res(200)]);
  const result = await uploadFile({
    file: makeFile(10), mimeType: 'video/mp4', init: okInit().init, fetchImpl, sleep: noSleep, chunkSize: 16, signal: controller.signal,
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(calls[0].signal, controller.signal);
});

test('returns cancelled when aborted while init is pending', async () => {
  const controller = new AbortController();
  const { fetchImpl, calls } = scriptedFetch([]);
  const init = async () => { controller.abort(); return { ok: true, uploadUrl: 'https://up/1' }; };
  const result = await uploadFile({ file: makeFile(10), mimeType: 'video/mp4', init, fetchImpl, sleep: noSleep, signal: controller.signal });
  assert.deepEqual(result, { ok: false, error: 'cancelled' });
  assert.equal(calls.length, 0);
});
