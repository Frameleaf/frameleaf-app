import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

test('container health accepts additive ping identity and rejects failed or invalid responses', () => {
  const directory = mkdtempSync(join(tmpdir(), 'frameleaf-healthcheck-'));
  const script = fileURLToPath(new URL('../../bin/frameleaf-healthcheck', import.meta.url));
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
          FRAMELEAF_WORKERS_INCLUDE: '',
          FRAMELEAF_WORKERS_EXCLUDE: '',
          FRAMELEAF_LOG_LEVEL: '',
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

// FL-294: `immich-healthcheck` and the IMMICH_* names keep working for unchanged Immich Compose files
test('the deprecated immich-healthcheck name and IMMICH_* variables still work', () => {
  const directory = mkdtempSync(join(tmpdir(), 'frameleaf-healthcheck-'));
  const legacy = fileURLToPath(new URL('../../bin/immich-healthcheck', import.meta.url));
  try {
    // curl records the address it was asked for and answers pong
    writeFileSync(
      join(directory, 'curl'),
      '#!/usr/bin/env bash\nprintf "%s" "${@: -1}" > "$CURL_URL_FILE"\nprintf \'{"res":"pong"}\'\n',
      {
        mode: 0o755,
      },
    );
    const urlFile = join(directory, 'url');
    const run = (env) =>
      spawnSync('sh', [legacy], {
        encoding: 'utf8',
        env: {
          PATH: `${directory}:${process.env.PATH}`,
          CURL_URL_FILE: urlFile,
          ...env,
        },
      });

    let result = run({ IMMICH_HOST: '10.0.0.5', IMMICH_PORT: '3001' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(readFileSync(urlFile, 'utf8'), 'http://10.0.0.5:3001/api/server/ping');

    result = run({ FRAMELEAF_HOST: '10.0.0.6', IMMICH_HOST: '10.0.0.5', FRAMELEAF_PORT: '3002' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(readFileSync(urlFile, 'utf8'), 'http://10.0.0.6:3002/api/server/ping');

    result = run({ IMMICH_WORKERS_EXCLUDE: 'api' });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /API worker excluded/);

    result = run({ FRAMELEAF_WORKERS_INCLUDE: 'microservices' });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /API worker excluded/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// FL-295: while the first start on an official library takes its safety copy, ping answers 503 (the
// API is not ready). The container still reports healthy, so an orchestrator that restarts unhealthy
// containers never interrupts the copy. Only the "Getting Ready…" worker answers that status.
test('the container stays healthy while the first start gets ready, under either name', () => {
  const directory = mkdtempSync(join(tmpdir(), 'frameleaf-healthcheck-'));
  const scripts = {
    frameleaf: ['bash', fileURLToPath(new URL('../../bin/frameleaf-healthcheck', import.meta.url))],
    immich: ['sh', fileURLToPath(new URL('../../bin/immich-healthcheck', import.meta.url))],
  };
  try {
    // curl -f: ping is refused with 503 (exit 22); the status answers as the test says
    writeFileSync(
      join(directory, 'curl'),
      [
        '#!/usr/bin/env bash',
        'url="${@: -1}"',
        'case "$url" in',
        '  */api/server/ping) printf \'{"statusCode":503}\'; exit 22 ;;',
        '  */api/server/getting-ready) printf "%s" "$STATUS_BODY"; exit "$STATUS_EXIT" ;;',
        'esac',
        'exit 7',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    const run = ([shell, script], body, exit = 0) =>
      spawnSync(shell, [script], {
        encoding: 'utf8',
        env: {
          PATH: `${directory}:${process.env.PATH}`,
          STATUS_BODY: body,
          STATUS_EXIT: String(exit),
        },
      });

    for (const script of Object.values(scripts)) {
      for (const state of ['checking', 'backing-up', 'skipped', 'done', 'ready', 'failed']) {
        const result = run(script, JSON.stringify({ state, copy: 'taken' }));
        assert.equal(result.status, 0, `${script[1]} ${state}: ${result.stdout}${result.stderr}`);
        assert.match(result.stdout, new RegExp(`getting ready \\(${state}\\)`));
      }
    }

    for (const [body, exit] of [
      // the normal server answers 404 there (curl -f exits 22): a failed ping stays a failure
      ['{"message":"Cannot GET /api/server/getting-ready","statusCode":404}', 22],
      // nothing answers
      ['', 7],
      ['{"state":"something-else"}', 0],
      ['not JSON', 0],
      ['{"state":"--eval=process.exit(0)"}', 0],
    ]) {
      for (const script of Object.values(scripts)) {
        const result = run(script, body, exit);
        assert.equal(result.status, 1, `${script[1]} ${body}: ${result.stdout}${result.stderr}`);
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
