import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nativeListener } from '../src/runtime/native-listener.js';

test('native Manager binds only the exact canonical loopback origin', () => {
  assert.deepEqual(nativeListener('https://127.0.0.1:9443'), {
    host: '127.0.0.1',
    port: 9443,
  });
  assert.deepEqual(nativeListener('https://[::1]:19443'), {
    host: '::1',
    port: 19443,
  });
  for (const origin of [
    'https://0.0.0.0:9443',
    'https://192.168.1.2:9443',
    'https://manager.test:9443',
    'https://localhost:9443',
    'http://127.0.0.1:9443',
    'https://127.0.0.1',
    'https://127.0.0.1:9443/',
    'https://127.0.0.1:9443/path',
    'https://127.0.0.1:9443?query',
    'https://127.0.0.1:9443#fragment',
    'https://user@127.0.0.1:9443',
    'https://127.1:9443',
    'https://127.0.0.1:09443',
  ])
    assert.throws(
      () => nativeListener(origin),
      /native_manager_origin_invalid/,
    );
});
