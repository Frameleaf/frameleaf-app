import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Docker, command } from '../src/docker.js';
import { findProblems, levelCounts, redactPaths, redactionRoots, renderReport } from '../src/troubleshooting.js';

test('library paths, media file names and e-mail addresses never reach a shared report', () => {
  const roots = ['/mnt/user/photos', '/data'];
  const log = [
    `[Nest] 7  - 11/06/2026 ERROR [Microservices:MetadataService] Failed to read /data/library/alice/2024/Paris trip/IMG_0042.HEIC`,
    `ENOENT: no such file or directory, open '/mnt/user/photos/Family Reunion 2019.jpg'`,
    `thumbnail failed for "Grandma's 90th birthday.mov"`,
    `user alice@example.com uploaded DSC_1234.NEF from C:\\Users\\alice\\Pictures\\holiday`,
    `/volume1/homes/bob/Photos/x.mp4 and /home/carol/Pictures`,
    `    at MediaService.handle (/usr/src/app/server/dist/services/media.service.js:120:11)`,
    `GET /api/server/ping 200`,
    `ffmpeg: /dev/dri/renderD128 not available`,
    `EACCES: scandir /photos/Summer Holiday 2023: permission denied`,
  ].join('\n');
  const out = redactPaths(log, roots);
  for (const leak of ['alice', 'Paris', 'IMG_0042', 'Family', 'Reunion', 'Grandma', 'DSC_1234', 'bob', 'carol', 'holiday', '@example.com', 'trip', 'Pictures', '90th', 'birthday', 'Summer', 'Holiday 2023'])
    assert.ok(!out.includes(leak), `${leak} leaked:\n${out}`);
  // What still helps someone diagnose it.
  assert.match(out, /\.HEIC/);
  assert.match(out, /\[file\]\.NEF/);
  assert.match(out, /\/usr\/src\/app\/server\/dist\/services\/media\.service\.js:120:11/);
  assert.match(out, /GET \/api\/server\/ping 200/);
  assert.match(out, /\/dev\/dri\/renderD128/);
  assert.match(out, /EACCES: scandir \[path\]: permission denied/);
});

test('a root of "/" or an empty mount is ignored rather than wiping every path', () => {
  assert.equal(redactPaths('at /usr/src/app/server/dist/main.js:1', ['/', '']), 'at /usr/src/app/server/dist/main.js:1');
});

test('known problems are counted once per kind with one example', () => {
  const log = [
    'FATAL:  the database system is starting up',
    'connect ECONNREFUSED 172.18.0.3:5432',
    'connect ECONNREFUSED 172.18.0.3:5432',
    'Error: ENOSPC: no space left on device, write',
    'INFO Using CUDAExecutionProvider',
    'timeout: 30000',
  ].join('\n');
  const problems = findProblems('frameleaf-server', log);
  assert.deepEqual(problems.map((p) => [p.problem, p.count]), [
    ['Database refused connection', 1],
    ['Connection refused', 2],
    ['Disk full', 1],
  ]);
  assert.deepEqual(levelCounts(log), { errors: 2, warnings: 0 });
  assert.equal(findProblems('ml', 'ERROR failed to create CUDAExecutionProvider: CUDA driver not found')[0].problem, 'Graphics acceleration failed');
});

test('the report leads with failed checks and problems', () => {
  const text = renderReport({
    generated: '2026-11-06T00:00:00.000Z',
    manager: 'v1.2.5',
    runtime: 'docker on unraid',
    installation: null,
    host: null,
    checks: [{ name: 'Docker', ok: false, detail: 'Manager cannot use Docker.' }],
    operations: [],
    logs: [{ service: 'database', text: 'PANIC: could not write: No space left on device' }],
  });
  const summary = text.slice(text.indexOf('== Summary =='), text.indexOf('== Connection checks =='));
  assert.match(summary, /Docker: Manager cannot use Docker/);
  assert.match(summary, /database: Disk full \(1×\)/);
  assert.match(text, /== Logs: database \(last 24 hours, 1 error and 0 warning lines\) ==/);
});

test('service logs keep stderr and come back in time order without timestamps', async () => {
  const id = 'a'.repeat(64);
  let seen: { args: string[]; mergeStderr?: boolean } | undefined;
  const docker = new Docker((async (_binary: string, args: string[], options: { mergeStderr?: boolean } = {}) => {
    seen = { args, mergeStderr: options.mergeStderr };
    // stdout arrives first, stderr after; Docker's fixed-width timestamps put them back in order.
    return [
      '2026-11-06T10:00:02.000000000Z second (stdout)',
      '2026-11-06T10:00:03.000000000Z third (stdout)',
      '2026-11-06T10:00:01.000000000Z first (stderr)',
      '',
    ].join('\n');
  }) as never);
  assert.equal(await docker.logs(id, { tail: 1000, since: '24h' }), 'first (stderr)\nsecond (stdout)\nthird (stdout)');
  assert.deepEqual(seen, { args: ['logs', '--timestamps', '--tail', '1000', '--since', '24h', id], mergeStderr: true });
});

test('merged streams keep whole lines when a stdout line arrives in two chunks around a stderr line', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manager-merge-'));
  const fake = join(directory, 'docker');
  await writeFile(
    fake,
    `#!${process.execPath}
const pause = () => new Promise((r) => setTimeout(r, 30));
(async () => {
  process.stdout.write('2026-11-06T10:00:02.000000000Z out-start');
  await pause();
  process.stderr.write('2026-11-06T10:00:01.000000000Z err-line\\n');
  await pause();
  process.stdout.write('-out-end\\n2026-11-06T10:00:03.000000000Z no-newline');
})();
`,
  );
  await chmod(fake, 0o700);
  try {
    const text = await command('docker', ['logs'], { executable: fake, mergeStderr: true });
    assert.deepEqual(text.split('\n').filter(Boolean).sort(), [
      '2026-11-06T10:00:01.000000000Z err-line',
      '2026-11-06T10:00:02.000000000Z out-start-out-end',
      '2026-11-06T10:00:03.000000000Z no-newline',
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('redaction stays fast on long lines without a media extension', () => {
  const lines = [
    '/a'.repeat(50_000),
    'x'.repeat(100_000),
    `/data/${'folder name '.repeat(5_000)}`,
    Array.from({ length: 2_000 }, () => `/usr/src/app/x${'y'.repeat(500)}`).join(' '),
  ].join('\n');
  const start = performance.now();
  const out = redactPaths(lines.repeat(20), ['/mnt/user/photos']);
  assert.ok(performance.now() - start < 2_000, `took ${Math.round(performance.now() - start)} ms`);
  assert.ok(out.split('\n').every((line) => line.length < 2_100));
});

test('configured folders are hidden even under /run; only container device and runtime mounts stay visible', () => {
  const roots = redactionRoots(['/run/private', '/mnt/archive', ''], ['/run/frameleaf/manager-token', '/dev/dri', '/srv/x', '/run/old-extra', '/run/frameleaf-host/private']);
  // A container still running with an extra folder the saved settings no longer list, even next to Manager's own mounts.
  assert.deepEqual(roots, ['/run/private', '/mnt/archive', '/srv/x', '/run/old-extra', '/run/frameleaf-host/private']);
  const out = redactPaths('open /run/private/alice/notes.txt failed; ffmpeg /dev/dri/renderD128; token /run/frameleaf/manager-token', roots);
  assert.ok(!out.includes('alice'), out);
  assert.match(out, /\/dev\/dri\/renderD128/);
  assert.match(out, /\/run\/frameleaf\/manager-token/);
});
