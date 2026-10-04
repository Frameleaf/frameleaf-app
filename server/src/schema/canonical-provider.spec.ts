import { createMigrationProvider } from '@frameleaf/sql-tools';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const first = '0000000000000-FrameleafBaseline';
const second = '0000000000001-NextFrameleafChange';

describe('canonical migration discovery', () => {
  let folder: string;
  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), 'frameleaf-migrations-'));
    await writeFile(join(folder, 'package.json'), '{"type":"module"}');
    await writeFile(join(folder, `${first}.js`), 'export async function up() {}');
    await writeFile(join(folder, 'ORDER'), `${first}\n`);
  });
  afterEach(async () => rm(folder, { recursive: true, force: true }));

  it('discovers an appended migration through the same provider used by runtime and CLI', async () => {
    await writeFile(join(folder, `${second}.js`), 'export async function up() {}');
    await writeFile(join(folder, 'ORDER'), `${first}\n${second}\n`);
    expect(Object.keys(await createMigrationProvider(folder).getMigrations())).toEqual([first, second]);
  });

  it('rejects a stale compiled legacy migration instead of executing it', async () => {
    await writeFile(join(folder, '1700000000000-LegacyMigration.js'), 'export async function up() {}');
    await expect(createMigrationProvider(folder).getMigrations()).rejects.toThrow(
      'unlisted [1700000000000-LegacyMigration]',
    );
  });

  it('rejects missing files and a missing manifest', async () => {
    await writeFile(join(folder, 'ORDER'), `${first}\n${second}\n`);
    await expect(createMigrationProvider(folder).getMigrations()).rejects.toThrow(`missing [${second}]`);
    await rm(join(folder, 'ORDER'));
    await expect(createMigrationProvider(folder).getMigrations()).rejects.toThrow();
  });

  it.each([`${first}\n${first}\n`, `${second}\n${first}\n`, '../outside\n'])(
    'rejects malformed order %s',
    async (order) => {
      await writeFile(join(folder, 'ORDER'), order);
      await expect(createMigrationProvider(folder).getMigrations()).rejects.toThrow(/ORDER/);
    },
  );
});
