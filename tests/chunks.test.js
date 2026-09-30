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
