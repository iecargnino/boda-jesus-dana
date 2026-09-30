const SERVER_ERRORS = ['no_space', 'invalid', 'server'];

// text/plain avoids a CORS preflight, which Apps Script web apps do not answer.
// The request is abortable by the caller and by a timeout, so a stalled POST cannot block the queue.
export function createInitClient({ endpoint, fetchImpl = (...args) => fetch(...args), timeoutMs = 30000 }) {
  return async function init(payload, { signal } = {}) {
    if (signal?.aborted) return { ok: false, error: 'cancelled' };

    const local = new AbortController();
    const onAbort = () => local.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => local.abort(), timeoutMs);

    try {
      let response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify({ action: 'init', ...payload }),
          signal: local.signal,
        });
      } catch {
        return { ok: false, error: signal?.aborted ? 'cancelled' : 'network' };
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
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  };
}
