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
