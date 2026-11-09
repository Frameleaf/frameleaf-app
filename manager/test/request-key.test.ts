import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestKey, startKey } from '../ui/src/request-key.js';

test('a start retried after a lost response reuses its key; a new review gets its own', () => {
  const keys = new Map<string, string>();
  const first = startKey(keys, 'review-a');
  assert.equal(startKey(keys, 'review-a'), first);
  assert.notEqual(startKey(keys, 'review-b'), first);
  keys.delete('review-a');
  assert.notEqual(startKey(keys, 'review-a'), first);
});

test('HTTP-compatible management request keys use cryptographic UUID v4 bytes', () => {
  const descriptor = Object.getOwnPropertyDescriptor(crypto, 'randomUUID');
  Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: undefined });
  try {
    const keys = Array.from({ length: 100 }, requestKey);
    assert.equal(new Set(keys).size, keys.length);
    for (const key of keys) assert.match(key, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  } finally {
    if (descriptor) Object.defineProperty(crypto, 'randomUUID', descriptor);
    else delete (crypto as any).randomUUID;
  }
});
