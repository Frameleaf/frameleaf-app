import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { createMigrationProvider } from '../dist/canonical-provider.js';
import { Migrator } from '../dist/index.js';

for (const custom of [false, true]) {
  test(`canonical migrations load from encoded file paths (custom loader: ${custom})`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'frameleaf-migration-url-'));
    const directory = join(root, 'migrations # café %');
    const name = '2100000000000-UrlFixture';
    try {
      await mkdir(directory);
      await writeFile(join(directory, 'ORDER'), `${name}\n`);
      await writeFile(join(directory, `${name}.mjs`), 'export async function up() {}\n');
      let called = false;
      const options = custom ? {
        import: async (filename) => {
          called = true;
          assert.equal(basename(filename), `${name}.mjs`);
          return import(pathToFileURL(filename).href);
        },
      } : {};
      const migrations = await createMigrationProvider(directory, options).getMigrations();
      assert.deepEqual(Object.keys(migrations), [name]);
      assert.equal(typeof migrations[name].up, 'function');
      assert.equal(called, custom);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test('schema generation imports encoded file paths before database comparison', async () => {
  const root = await mkdtemp(join(tmpdir(), 'frameleaf-schema-url-'));
  const directory = join(root, 'schema # café %');
  const migrator = new Migrator({
    connectionParams: { connectionType: 'url', url: 'postgres://fixture:fixture@127.0.0.1:1/fixture' },
    migrationFolder: root,
  });
  try {
    await mkdir(directory);
    await writeFile(join(directory, 'package.json'), '{"type":"module"}');
    await writeFile(join(directory, 'fixture.js'), 'throw new Error("encoded_schema_fixture_loaded");\n');
    await assert.rejects(
      migrator.generate({ dist: directory, targetPath: join(root, 'unused.ts'), withComments: false }),
      /encoded_schema_fixture_loaded/,
    );
  } finally {
    await migrator.getDatabase().destroy();
    await rm(root, { recursive: true, force: true });
  }
});
