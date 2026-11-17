import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Repository, backup, find, memoryStore, mountSource, readFile, verify, type Source } from '@frameleaf/backup-core';

// Manager ships the backup engine as an installed copy. This fails if the dependency is missing, is a
// link (which would dangle in the image), or no longer runs on Manager's Node.
test('the backup engine Manager ships with is a real copy and backs up and reads back a folder', async () => {
  const installed = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', '@frameleaf', 'backup-core');
  assert.equal((await lstat(installed)).isSymbolicLink(), false);

  const body = randomBytes(40_000);
  const documents: Source = {
    list: async (path) =>
      path.length === 0 ? [{ name: 'tax.xlsx', type: 'file', mode: 0o644, uid: 0, gid: 0, mtime: 0, size: body.length }] : [],
    async *read() {
      yield body;
    },
  };
  const repository = await Repository.init(memoryStore(), { rootKey: randomBytes(32) });
  const { snapshot } = await backup(repository, mountSource([{ path: ['mnt', 'user', 'documents'], source: documents }]));
  assert.deepEqual((await verify(repository, { readPack: () => true })).missing, []);
  const parts: Buffer[] = [];
  for await (const chunk of readFile(repository, (await find(repository, snapshot, ['mnt', 'user', 'documents', 'tax.xlsx']))!)) {
    parts.push(chunk);
  }
  assert.ok(Buffer.concat(parts).equals(body));
});
