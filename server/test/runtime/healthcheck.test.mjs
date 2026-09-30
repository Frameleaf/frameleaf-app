import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

test('container health accepts additive ping identity and rejects failed or invalid responses', () => {
  const directory = mkdtempSync(join(tmpdir(), 'frameleaf-healthcheck-'));
  const script = fileURLToPath(new URL('../../bin/immich-healthcheck', import.meta.url));
  try {
    writeFileSync(
      join(directory, 'curl'),
      '#!/usr/bin/env bash\nprintf "%s" "$HEALTHCHECK_BODY"\nexit "$HEALTHCHECK_EXIT"\n',
      {
        mode: 0o755,
      },
    );
    for (const [body, curlExit, expected] of [
      ['{"res":"pong"}', 0, 0],
      ['{"res":"pong","id":"stable-id","linked":false,"name":"Frameleaf"}', 0, 0],
      ['{ "name": "Frameleaf", "res": "pong" }', 0, 0],
      ['{"res":"wrong"}', 0, 1],
      ['{"id":"stable-id"}', 0, 1],
      ['not JSON', 0, 1],
      ['--version', 0, 1],
      ['--eval=process.exit(0)', 0, 1],
      ['null', 0, 1],
      ['{"res":"pong"}', 22, 1],
    ]) {
      const result = spawnSync('bash', [script], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH}`,
          IMMICH_WORKERS_INCLUDE: '',
          IMMICH_WORKERS_EXCLUDE: '',
          IMMICH_LOG_LEVEL: '',
          HEALTHCHECK_BODY: body,
          HEALTHCHECK_EXIT: String(curlExit),
        },
      });
      assert.equal(result.status, expected, `${body}: ${result.stdout}${result.stderr}`);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
