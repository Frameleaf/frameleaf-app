// FL-465: an Immich container with IMMICH_PORT=80 was skipped: Manager asked 127.0.0.1:2283 for its version.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { versionUrl } from '../src/discovery.js';

test("the version check uses the Immich container's own port and listen address", () => {
  assert.equal(versionUrl({}), 'http://127.0.0.1:2283/api/server/version');
  assert.equal(versionUrl({ IMMICH_PORT: '80', IMMICH_HOST: '0.0.0.0' }), 'http://127.0.0.1:80/api/server/version');
  assert.equal(versionUrl({ IMMICH_PORT: '3001', IMMICH_HOST: '::' }), 'http://127.0.0.1:3001/api/server/version');
  assert.equal(versionUrl({ IMMICH_HOST: '192.168.4.21' }), 'http://192.168.4.21:2283/api/server/version');
  assert.equal(versionUrl({ IMMICH_HOST: 'fd00::21', IMMICH_PORT: '8080' }), 'http://[fd00::21]:8080/api/server/version');
  // Nonsense falls back to Immich's defaults rather than building a URL from it.
  assert.equal(versionUrl({ IMMICH_PORT: '99999', IMMICH_HOST: 'evil.example/x' }), 'http://127.0.0.1:2283/api/server/version');
});
