import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GUEST_STORAGE_KEY,
  ANONYMOUS_LABEL,
  canContinue,
  resolveGuestName,
  displayGuestName,
  parseGuest,
  serializeGuest,
} from '../web/lib/guest.js';

test('constants', () => {
  assert.equal(GUEST_STORAGE_KEY, 'guest');
  assert.equal(ANONYMOUS_LABEL, 'Anónimo');
});

test('canContinue: named, blank, anonymous', () => {
  assert.equal(canContinue({ name: 'Ema', anonymous: false }), true);
  assert.equal(canContinue({ name: '   ', anonymous: false }), false);
  assert.equal(canContinue({ name: '', anonymous: true }), true);
});

test('resolveGuestName trims and clears when anonymous', () => {
  assert.equal(resolveGuestName({ name: '  Tío Ema  ', anonymous: false }), 'Tío Ema');
  assert.equal(resolveGuestName({ name: 'Ema', anonymous: true }), '');
});

test('displayGuestName', () => {
  assert.equal(displayGuestName({ name: ' Tío Ema ', anonymous: false }), 'Tío Ema');
  assert.equal(displayGuestName({ name: 'Ema', anonymous: true }), 'Anónimo');
});

test('parseGuest round-trips serializeGuest', () => {
  const value = { name: 'Tía Marta', anonymous: false };
  assert.deepEqual(parseGuest(serializeGuest(value)), value);
  assert.deepEqual(parseGuest(serializeGuest({ name: 'x', anonymous: true })), { name: '', anonymous: true });
});

test('parseGuest rejects missing, corrupt and invalid input', () => {
  assert.equal(parseGuest(null), null);
  assert.equal(parseGuest(undefined), null);
  assert.equal(parseGuest(''), null);
  assert.equal(parseGuest('{not json'), null);
  assert.equal(parseGuest('null'), null);
  assert.equal(parseGuest('{"name":"   ","anonymous":false}'), null);
  assert.equal(parseGuest('{"name":5,"anonymous":false}'), null);
  assert.equal(parseGuest('{"name":"x","anonymous":"yes"}'), null);
});

test('serializeGuest clears name when anonymous and trims otherwise', () => {
  assert.equal(serializeGuest({ name: 'Ema', anonymous: true }), '{"name":"","anonymous":true}');
  assert.equal(serializeGuest({ name: '  Ema ', anonymous: false }), '{"name":"Ema","anonymous":false}');
});
