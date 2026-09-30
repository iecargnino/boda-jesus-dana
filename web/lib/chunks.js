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
