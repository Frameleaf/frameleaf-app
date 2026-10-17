import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

for (const filename of ['Dockerfile', 'Dockerfile.dev']) {
  test(`${filename} retains newer native dependencies and requests architecture-specific minimums`, () => {
    const source = readFileSync(new URL(`../${filename}`, import.meta.url), 'utf8');
    const installs = source
      .split('\n')
      .filter((line) => line.includes('darktable-runtime-packages.txt') && !line.startsWith('COPY'));
    assert.equal(installs.length, filename === 'Dockerfile' ? 2 : 1);
    const directory = mkdtempSync(path.join(tmpdir(), 'frameleaf-native-apt-'));
    try {
      const manifest = path.join(directory, 'packages.txt');
      const dependencies = path.join(directory, 'dependencies.txt');
      const receipt = path.join(directory, 'args.json');
      const quote = (value) => `'${value.replaceAll("'", () => String.raw`'\''`)}'`;
      const records = 'libexample:arm64=2:1.0~rc1-1\nlibexample2:amd64=3.4+deb13u1\n';
      writeFileSync(manifest, records);
      writeFileSync(
        path.join(directory, 'apt-get'),
        '#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.env.FRAMELEAF_APT_ARGS, JSON.stringify(process.argv.slice(2)));\n',
        { mode: 0o755 },
      );
      for (const line of installs) {
        const command = line
          .trim()
          .replace(/^RUN apt-update-strict && /, '')
          .replace(/ && \\$/, '')
          .replaceAll('/build/darktable-runtime-packages.txt', () => quote(manifest))
          .replaceAll('/tmp/darktable-runtime-dependencies.txt', () => quote(dependencies));
        const options = {
          env: { PATH: `${directory}:${process.env.PATH}`, FRAMELEAF_APT_ARGS: receipt },
          stdio: 'pipe',
        };
        execFileSync('sh', ['-c', command], options);
        assert.deepEqual(JSON.parse(readFileSync(receipt, 'utf8')), [
          'satisfy',
          '--no-install-recommends',
          '-yqq',
          'libexample:arm64 (>= 2:1.0~rc1-1)',
          'libexample2:amd64 (>= 3.4+deb13u1)',
        ]);
        rmSync(receipt);
        writeFileSync(path.join(directory, 'sed'), '#!/bin/sh\nexit 73\n', { mode: 0o755 });
        assert.throws(() => execFileSync('sh', ['-c', command], options));
        assert.equal(existsSync(receipt), false);
        rmSync(path.join(directory, 'sed'));
        writeFileSync(manifest, '');
        assert.throws(() => execFileSync('sh', ['-c', command], options));
        assert.equal(existsSync(receipt), false);
        rmSync(manifest);
        assert.throws(() => execFileSync('sh', ['-c', command], options));
        assert.equal(existsSync(receipt), false);
        writeFileSync(manifest, records);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
