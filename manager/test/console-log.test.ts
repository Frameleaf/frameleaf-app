import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { elapsed, renderBanner, requestLog, requestLogPath } from '../src/banner.js';

const run = (method: string, originalUrl: string, statusCode: number, finished = true) => {
  const lines: string[] = [];
  const res = Object.assign(new EventEmitter(), { statusCode, writableFinished: finished });
  let called = false;
  requestLog((line) => lines.push(line))({ method, originalUrl }, res, () => (called = true));
  res.emit('close');
  assert.ok(called);
  return lines;
};

test('request lines never carry query values or IDs', () => {
  const secret = 'synthetic-setup-code-7f3a9c2e1b';
  const [line] = run('POST', `/manager-api/claim?code=${secret}&token=${secret}`, 200);
  assert.match(line, /^POST \/manager-api\/claim\?code=\*{8}&token=\*{8} 200 \d+ms$/);
  assert.ok(!line.includes(secret));
  assert.equal(
    requestLogPath('/manager-api/operations/2f1c9a0e-5b7d-4c3e-9a1f-0e2d3c4b5a69/resume'),
    '/manager-api/operations/:id/resume',
  );
});

test('dashboard polls and static files are quiet; failed polls and aborts are not', () => {
  assert.deepEqual(run('GET', '/manager-api/dashboard', 200), []);
  assert.deepEqual(run('GET', '/assets/index.js', 200), []);
  assert.match(run('GET', '/manager-api/dashboard', 401)[0], / 401 /);
  assert.match(run('POST', '/manager-api/backup', 200, false)[0], / aborted /);
});

test('the banner fits 10 lines by 60 columns and is plain ASCII without colour', () => {
  const banner = renderBanner('Frameleaf Manager', 'v1.2.4', { color: false });
  const lines = banner.split('\n');
  assert.ok(lines.length <= 10);
  assert.ok(lines.every((line) => line.length <= 60));
  assert.match(banner, /^[\x20-\x7e\n]+$/);
  assert.ok(banner.includes('Frameleaf Manager') && banner.includes('v1.2.4'));
  assert.ok(renderBanner('Frameleaf', 'v1', { color: true }).includes('\u001B[32m'));
});

test('durations read naturally', () => {
  assert.equal(elapsed(0, 850), '850ms');
  assert.equal(elapsed(0, 12_340), '12.3s');
  assert.equal(elapsed(0, 245_000), '4m 05s');
});
