import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { loadLibraryImportBundle } from 'src/library-import/bundle-input.js';
import { openPrivateImportFile, readPrivateImportJSON } from 'src/library-import/command-input.js';
import fixture from 'src/library-import/fixtures/manager-plan-v2.json' with { type: 'json' };
import {
  EMPTY_SOURCE_ARCHIVE_HASH,
  advanceSourceArchiveHash,
  encodeSourceArchiveRecord,
} from 'src/library-import/source-archive-codec.js';

vi.mock('src/library-import/command-input.js', () => ({
  readPrivateImportJSON: vi.fn(),
  openPrivateImportFile: vi.fn(),
}));
let directory: string;
let values: Map<string, unknown>;
const record = { table: 'photos', value: { id: 1n, title: 'manual caption' } };
const config = {
  format: 'frameleaf-library-import-command' as const,
  version: 1 as const,
  operationId: randomUUID(),
  destinationId: fixture.plan.destinationId,
  bundleDirectory: '/private/bundle',
  stateDirectory: '/private/state',
};

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'frameleaf-bundle-input-'));
  const plan = { ...fixture.plan, owners: [], files: [] };
  const encoded = encodeSourceArchiveRecord(record);
  values = new Map<string, unknown>([
    ['plan.json', plan],
    [
      'manifest.json',
      {
        format: 'frameleaf-library-import',
        version: 3,
        source: plan.source,
        inventory: {
          complete: true,
          ownershipComplete: true,
          privacyComplete: true,
          writersStopped: true,
          revisionBefore: plan.source.revision,
          revisionAfter: plan.source.revision,
        },
        users: [],
        files: [],
        assets: [],
        albums: [],
        losses: [],
      },
    ],
    ['owners.json', { format: 'frameleaf-private-owner-inputs', version: 1, owners: [] }],
    [
      'archive.json',
      {
        format: 'frameleaf-source-archive',
        version: 1,
        rows: '1',
        sha256: advanceSourceArchiveHash(EMPTY_SOURCE_ARCHIVE_HASH, encoded),
      },
    ],
  ]);
  vi.mocked(readPrivateImportJSON).mockImplementation((path) => {
    const value = values.get(basename(path));
    return Promise.resolve({ value, sha256: createHash('sha256').update(JSON.stringify(value)).digest('hex') });
  });
  vi.mocked(openPrivateImportFile).mockImplementation(() => open(join(directory, 'archive.jsonl'), 'r'));
  await writeFile(join(directory, 'archive.jsonl'), JSON.stringify(encoded) + '\n');
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

it('builds one bound import context and exhausts the complete lossless archive', async () => {
  const bundle = await loadLibraryImportBundle(config, 'photoprism');
  expect(bundle.context.binding).toMatchObject({ operationId: config.operationId, source: fixture.plan.source });
  expect(bundle.owners).toEqual([]);
  const actual = [];
  for await (const row of bundle.records()) actual.push(row);
  expect(actual).toEqual([record]);
  await expect(bundle.assertUnchanged()).resolves.toBeUndefined();
});

it('refuses changing the selected source family or a private metadata input', async () => {
  await expect(loadLibraryImportBundle(config, 'ente')).rejects.toThrow('IMPORT_SOURCE_KIND_CHANGED');
  const bundle = await loadLibraryImportBundle(config, 'photoprism');
  values.set('owners.json', { format: 'frameleaf-private-owner-inputs', version: 1, owners: ['changed'] });
  await expect(bundle.assertUnchanged()).rejects.toThrow('IMPORT_BUNDLE_CHANGED');
});

it.each(['truncated', 'extra row', 'credential column'])(
  'refuses an archive with %s instead of accepting a partial or unsafe export',
  async (corruption) => {
    const bundle = await loadLibraryImportBundle(config, 'photoprism');
    const encoded = encodeSourceArchiveRecord(record);
    const content =
      corruption === 'truncated'
        ? ''
        : corruption === 'extra row'
          ? JSON.stringify(encoded) + '\n' + JSON.stringify(encoded) + '\n'
          : JSON.stringify({
              table: 'photos',
              fields: [['password_hash', ['text', Buffer.from('private-value', 'utf16le').toString('base64')]]],
            });
    await writeFile(join(directory, 'archive.jsonl'), content);
    await expect(bundle.assertUnchanged()).rejects.toThrow(
      corruption === 'extra row'
        ? 'SOURCE_ARCHIVE_COUNT_MISMATCH'
        : corruption === 'credential column'
          ? 'SOURCE_ARCHIVE_CREDENTIAL_COLUMN'
          : 'SOURCE_ARCHIVE_RECORD_CHANGED',
    );
  },
);

it('stops oversized archive lines before parsing an unbounded record', async () => {
  const bundle = await loadLibraryImportBundle(config, 'photoprism');
  await writeFile(join(directory, 'archive.jsonl'), 'x'.repeat(8 * 1024 * 1024 + 1));
  await expect(bundle.assertUnchanged()).rejects.toThrow('SOURCE_ARCHIVE_RECORD_INVALID');
});
