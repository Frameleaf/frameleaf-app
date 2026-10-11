import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, chown, mkdir, mkdtemp, rm, statfs, writeFile } from 'node:fs/promises';
import { release, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test(
  'a private Linux key mount denies an unrelated UID, with a positive access control',
  {
    skip: process.platform !== 'linux' || process.getuid() !== 0,
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'frameleaf-key-permissions-'));
    const directory = join(root, 'identity');
    const key = join(directory, 'cloud-backup-ABCD-1234.key');
    const runAs = (uid, source) => {
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', source, directory, key], {
        uid,
        gid: uid,
        env: {},
        encoding: 'utf8',
      });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
    };
    try {
      // An accessible parent ensures the negative probe tests the identity directory itself.
      await chmod(root, 0o755);
      await mkdir(directory, { mode: 0o700 });
      await writeFile(key, 'synthetic', { mode: 0o600 });
      await chown(key, 1000, 1000);
      await chown(directory, 1000, 1000);
      runAs(
        1000,
        `import assert from 'node:assert/strict'; import {readFileSync,readdirSync} from 'node:fs';
      assert.equal(readFileSync(process.argv[2], 'utf8'), 'synthetic');
      assert.equal(readdirSync(process.argv[1]).length, 1);`,
      );
      runAs(
        65534,
        `import assert from 'node:assert/strict'; import {readFileSync,readdirSync} from 'node:fs';
      assert.throws(() => readdirSync(process.argv[1]), {code:'EACCES'});
      assert.throws(() => readFileSync(process.argv[2]), {code:'EACCES'});`,
      );
      await chmod(directory, 0o755);
      runAs(
        65534,
        `import assert from 'node:assert/strict'; import {readFileSync,readdirSync} from 'node:fs';
      assert.equal(readdirSync(process.argv[1]).length, 1);
      assert.throws(() => readFileSync(process.argv[2]), {code:'EACCES'});`,
      );
      await chmod(key, 0o644);
      runAs(
        65534,
        `import assert from 'node:assert/strict'; import {readFileSync} from 'node:fs';
      assert.equal(readFileSync(process.argv[2], 'utf8'), 'synthetic');`,
      );
      console.log(
        `Synthetic qualification: Linux ${release()}, Node ${process.version}, filesystem type 0x${(await statfs(root)).type.toString(16)}, owner 1000, unrelated UID 65534`,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
