import {
  CHUNK_SIZE, chunkRange, contentRange, statusContentRange, parseRangeHeader, backoffDelay,
} from './chunks.js';

// Resolves after ms, or early when the signal aborts.
const defaultSleep = (ms, signal) => new Promise((resolve) => {
  if (signal?.aborted) { resolve(); return; }
  const onAbort = () => { clearTimeout(timer); resolve(); };
  const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
  signal?.addEventListener('abort', onAbort, { once: true });
});

const CANCELLED = { ok: false, error: 'cancelled' };

const isDone = (status) => status === 200 || status === 201;
const isExpired = (status) => status === 404 || status === 410;
const isRetryable = (status) => status >= 500 || status === 408 || status === 429;

// Asks Drive how many bytes it has persisted. Returns 'done', an offset, or null if unknown.
async function queryOffset(fetchImpl, uploadUrl, total, signal) {
  try {
    const res = await fetchImpl(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Range': statusContentRange(total) },
      body: null,
      signal,
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
  maxAttempts = 10,
  signal,
}) {
  const total = file.size;
  const openSession = () => init({ fileName: file.name, mimeType, size: total, guestName, origin }, { signal });

  if (signal?.aborted) return CANCELLED;
  let session = await openSession();
  if (signal?.aborted) return CANCELLED;
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
        signal,
      });
    } catch {
      res = null;
    }
    if (signal?.aborted) return CANCELLED;

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
      if (signal?.aborted) return CANCELLED;
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
    await sleep(backoffDelay(attempts - 1), signal);
    if (signal?.aborted) return CANCELLED;

    const confirmed = await queryOffset(fetchImpl, uploadUrl, total, signal);
    if (signal?.aborted) return CANCELLED;
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
