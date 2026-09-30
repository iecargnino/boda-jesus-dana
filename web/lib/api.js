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
