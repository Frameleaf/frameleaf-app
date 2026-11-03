import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { adoptImportFiles } from '../src/import-adoption.js';
import { copyImportFiles } from '../src/import-copy.js';
import {
  relocateImportFiles,
  rollbackImportRelocations,
} from '../src/import-relocation.js';
import {
  ImportTransferJournal,
  type ImportTransfer,
} from '../src/import-transfer-journal.js';
import { Store } from '../src/store.js';
import { reviewedImport } from './import-plan-fixture.js';

test(
  'one reviewed library can copy, adopt and relocate independent originals, then resume and reverse its moves',
  { skip: process.platform !== 'linux' },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'frameleaf-mixed-transfer-'));
    let store: Store | undefined;
    try {
      const source = join(root, 'source'),
        destination = join(root, 'destination');
      await mkdir(source, { mode: 0o700 });
      await mkdir(destination, { mode: 0o700 });
      const roots = [];
      for (const [id, path] of [
        ['source', source],
        ['destination', destination],
      ]) {
        const value = await stat(path, { bigint: true });
        roots.push({
          id,
          path,
          device: String(value.dev),
          inode: String(value.ino),
        });
      }
      const files: ImportTransfer[] = [];
      for (const mode of ['copy', 'adopt', 'relocate'] as const) {
        const path = mode + '.jpg',
          bytes = Buffer.from('synthetic-' + mode);
        await writeFile(join(source, path), bytes);
        const value = await stat(join(source, path), { bigint: true });
        files.push({
          id: mode,
          mode,
          sourceRoot: 'source',
          sourcePath: path,
          destinationRoot: mode === 'adopt' ? 'source' : 'destination',
          destinationPath: path,
          bytes: String(bytes.length),
          sha256: createHash('sha256').update(bytes).digest('hex'),
          destinationDevice: roots[1].device,
          sourceIdentity: {
            device: String(value.dev),
            inode: String(value.ino),
            bytes: String(value.size),
            mtimeNs: String(value.mtimeNs),
            ctimeNs: String(value.ctimeNs),
            links: String(value.nlink),
          },
        });
      }
      const reviewed = reviewedImport(files, roots);
      store = new Store(join(root, 'state'));
      const operation = store.start('import', 'mixed-transfer', {}).operation;
      let journal = new ImportTransferJournal(store);
      journal.begin(operation.id, reviewed.binding);
      journal.sealPlan(operation.id, reviewed.plan);
      for (const file of files) journal.intent(operation.id, file);
      const mounted = Object.fromEntries(
        roots.map((value) => [value.id, value]),
      );
      const forward = async (resume: boolean) => {
        assert.equal(
          (await copyImportFiles(journal, operation.id, mounted, resume)).files,
          1,
        );
        assert.equal(
          (await adoptImportFiles(journal, operation.id, mounted)).files,
          1,
        );
        assert.equal(
          (await relocateImportFiles(journal, operation.id, mounted, resume))
            .files,
          1,
        );
      };
      await forward(false);
      store.close();
      store = new Store(join(root, 'state'));
      journal = new ImportTransferJournal(store);
      await forward(true);
      assert.deepEqual(
        journal.files(operation.id).map(({ state }) => state),
        ['verified', 'verified', 'verified'],
      );
      assert.equal(
        (await rollbackImportRelocations(journal, operation.id, mounted)).files,
        1,
      );
      for (const mode of ['copy', 'adopt', 'relocate'])
        assert.equal(
          await readFile(join(source, mode + '.jpg'), 'utf8'),
          'synthetic-' + mode,
        );
      assert.equal(
        await readFile(join(destination, 'copy.jpg'), 'utf8'),
        'synthetic-copy',
      );
      assert.throws(() => journal.writersStarting(operation.id));
    } finally {
      store?.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
