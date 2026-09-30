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
