import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import media from 'src/library-import/fixtures/ente/0.4.2-media.json' with { type: 'json' };
import { ENTE_EXPORT_FILE, ENTE_INVENTORY_FILE, adapter } from 'src/library-import/preparation/ente.js';
import { adapter as lychee } from 'src/library-import/preparation/lychee.js';
import { UNTESTED_VERSION_LOSS, inspectPreparationSource } from 'src/library-import/preparation/prepare.js';
import { assertPreparationLocation } from 'src/library-import/prepare-command.js';
import { type SourceArchiveRecord } from 'src/library-import/source-archive-codec.js';

const fixtureMedia = (name: string) => readFile(new URL(`../fixtures/ente/media/${name}`, import.meta.url));

/** `ente photos export` for one account, plus the `file list --all --json` inventory saved beside it. */
async function writeExport(root: string, account: 'alice' | 'bob', extra: typeof media.cases = []) {
  const cases = [...media.cases.filter((row) => row.account === account), ...extra];
  await writeFile(
    join(root, ENTE_EXPORT_FILE),
    JSON.stringify({ format: 'ente-photos-export', version: 1, userID: media.users[account] }),
  );
  const inventory = new Map(cases.map((row) => [row.inventory.id, row.inventory]));
  await writeFile(join(root, ENTE_INVENTORY_FILE), JSON.stringify(inventory.values().toArray()));
  for (const row of cases) {
    const folder = join(root, row.folder);
    await mkdir(join(folder, 'metadata'), { recursive: true });
    await writeFile(join(folder, 'metadata.json'), JSON.stringify(row.album));
    const component = row.expected.find((file) => file.role === row.record.ente.component)!;
    await writeFile(join(folder, 'metadata', component.path + '.json'), JSON.stringify(row.record));
    await writeFile(join(folder, component.path), await fixtureMedia(component.input));
  }
  // The CLI's export history: never read.
  await mkdir(join(root, 'Trash', 'Old album', 'metadata'), { recursive: true });
  await writeFile(join(root, 'Trash', 'Old album', 'metadata.json'), '{not json');
}

describe('Ente preparation adapter', () => {
  let directory: string;
  let originalsRoot: string;
  const input = () => ({
    source: {
      kind: 'ente' as const,
      version: 'ente-cli',
      identity: media.users.alice,
      revision: 'a'.repeat(64),
      schemaSha256: 'a'.repeat(64),
    },
    originalsRoot,
  });

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'frameleaf-prepare-ente-'));
    originalsRoot = join(directory, 'export');
    await mkdir(originalsRoot);
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('inspects one account of the native CLI export as tested', async () => {
    await writeExport(originalsRoot, 'alice');
    const inspection = await inspectPreparationSource(adapter, input());
    expect(inspection).toMatchObject({
      tested: true,
      testedVersion: media.provenance.exporter,
      source: input().source,
      // Four files: a Live Photo is a photo plus its hidden motion video; three album folders hold them.
      summary: { owners: 1, assets: 5, albums: 2, files: 5, bytes: String(982 * 3 + 1745 * 2) },
      owners: [
        {
          sourceId: media.users.alice,
          name: `Ente account ${media.users.alice}`,
          email: null,
          assets: 5,
          restrictions: [],
        },
      ],
    });
    const codes = inspection.losses.map((loss) => loss.code);
    expect(codes).toContain('ENTE_SOURCE_METADATA_ARCHIVED');
    expect(codes).not.toContain(UNTESTED_VERSION_LOSS);
    expect(codes).not.toContain('ENTE_SHARED_FILE_NOT_IMPORTED');
  });

  it('leaves out files another account shared and reports each one, without reading their bytes', async () => {
    const bobFile = media.cases.filter((row) => row.inventory.id === media.ids.bobFile);
    await writeExport(originalsRoot, 'alice', bobFile);
    await rm(join(originalsRoot, 'Bob private', 'Same bytes different owner.jpg'));
    const inspection = await inspectPreparationSource(adapter, input());
    expect(inspection.summary).toMatchObject({ owners: 1, assets: 5, albums: 2, files: 5 });
    expect(inspection.owners.map((owner) => owner.sourceId)).toEqual([media.users.alice]);
    expect(inspection.losses).toContainEqual({ code: 'ENTE_SHARED_FILE_NOT_IMPORTED', count: 1 });
    expect(inspection.losses).toContainEqual({ code: 'ENTE_SHARING_RESTRICTED', count: 1 });
  });

  it('keeps an account’s own files in an album another account owns', async () => {
    await writeExport(originalsRoot, 'alice');
    const album = join(originalsRoot, 'Second collection', 'metadata.json');
    const record = JSON.parse(await readFile(album, 'utf8'));
    record.ente.ownerID = media.users.bob;
    await writeFile(album, JSON.stringify(record));
    const inspection = await inspectPreparationSource(adapter, input());
    expect(inspection.summary).toMatchObject({ owners: 1, assets: 5, albums: 2 });
    expect(inspection.losses).toContainEqual({ code: 'ENTE_SHARING_RESTRICTED', count: 1 });
  });

  it('refuses an export without the account inventory', async () => {
    await writeExport(originalsRoot, 'alice');
    await rm(join(originalsRoot, ENTE_INVENTORY_FILE));
    await expect(inspectPreparationSource(adapter, input())).rejects.toThrow('ENTE_INVENTORY_REQUIRED');
    await writeFile(join(originalsRoot, ENTE_INVENTORY_FILE), '{"not":"a list"}');
    await expect(inspectPreparationSource(adapter, input())).rejects.toThrow('ENTE_INVENTORY_REQUIRED');
  });

  it('refuses when an original is missing from the export', async () => {
    await writeExport(originalsRoot, 'alice');
    await rm(join(originalsRoot, 'Owner hidden 🌧', 'movie.mov'));
    await expect(inspectPreparationSource(adapter, input())).rejects.toThrow('IMPORT_SOURCE_ORIGINALS_MISSING');
  });

  it('reads an export with fields the qualified CLI did not write best effort', async () => {
    await writeExport(originalsRoot, 'alice');
    const path = join(originalsRoot, ENTE_EXPORT_FILE);
    await writeFile(
      path,
      JSON.stringify({ ...JSON.parse(await readFile(path, 'utf8')), exportedBy: 'ente-cli-v0.5.0' }),
    );
    const inspection = await inspectPreparationSource(adapter, input());
    expect(inspection.tested).toBe(false);
    expect(inspection.summary).toMatchObject({ owners: 1, assets: 5, albums: 2, files: 5 });
    expect(inspection.losses).toContainEqual({ code: UNTESTED_VERSION_LOSS, count: 1 });
  });

  it('proves every original against its sidecar hash and names files relative to the export', async () => {
    await writeExport(originalsRoot, 'alice');
    const observe = async () => {
      const source = await adapter.open(input());
      const files = await Promise.all(
        (await source.files()).map(async (file) => {
          const bytes = await readFile(join(originalsRoot, file.path));
          const info = await stat(join(originalsRoot, file.path));
          return {
            ...file,
            bytes: String(bytes.length),
            sha256: createHash('sha256').update(bytes).digest('hex'),
            modifiedAt: info.mtime.toISOString(),
          };
        }),
      );
      return source.manifest(files);
    };
    const { manifest, archive } = await observe();
    expect(manifest.files.map((file) => file.path).toSorted()).toEqual([
      'Favorites/Manual cover.jpg',
      'Owner hidden 🌧/Motion.jpg',
      'Owner hidden 🌧/Motion.mov',
      'Owner hidden 🌧/frame-128.jpg',
      'Owner hidden 🌧/movie.mov',
    ]);
    const placements = [...(archive as Iterable<SourceArchiveRecord>)].filter(
      (record) => record.table === 'frameleaf_ente_placement',
    );
    expect(placements.map((record) => record.value.path)).toContain('Second collection/Manual cover.jpg');
    // Same size, different bytes: the sidecar's BLAKE2b hash no longer matches.
    const changed = Buffer.from(await fixtureMedia('photo.jpg'));
    changed[changed.length - 3] ^= 0xff;
    await writeFile(join(originalsRoot, 'Owner hidden 🌧', 'frame-128.jpg'), changed);
    await expect(observe()).rejects.toThrow('ENTE_FILE_EVIDENCE_MISMATCH');
  });
});

describe('preparation delivery', () => {
  const staging = '/import-preparation';
  it('accepts neither a snapshot nor a database only for an export-folder adapter', () => {
    expect(() => assertPreparationLocation({}, adapter, staging)).not.toThrow();
    expect(() => assertPreparationLocation({}, lychee, staging)).toThrow('IMPORT_PREPARATION_INPUT_INVALID');
    expect(() => assertPreparationLocation({ snapshotPath: `${staging}/source.sqlite` }, adapter, staging)).toThrow(
      'IMPORT_PREPARATION_INPUT_INVALID',
    );
    expect(() =>
      assertPreparationLocation({ snapshotPath: `${staging}/source.sqlite` }, lychee, staging),
    ).not.toThrow();
    expect(() =>
      assertPreparationLocation(
        { snapshotPath: `${staging}/source.sqlite`, databaseUrl: 'postgres://reader@127.0.0.1/db' },
        { databases: ['sqlite', 'postgres', 'export'] },
        staging,
      ),
    ).toThrow('IMPORT_PREPARATION_INPUT_INVALID');
  });
});
