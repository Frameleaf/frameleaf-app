import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  type Source,
  type SourceEntry,
  Repository,
  backup,
  filterSource,
  listFolder,
  measureSource,
  memoryStore,
  mountSource,
} from '../src/index.js';

const file = (name: string, size: number): SourceEntry => ({
  name,
  type: 'file',
  mode: 0o644,
  uid: 0,
  gid: 0,
  mtime: 0,
  size,
});
const flat = (files: Record<string, Buffer>): Source => ({
  list: async (path) => (path.length === 0 ? Object.entries(files).map(([name, body]) => file(name, body.length)) : []),
  async *read(path) {
    yield files[path[0]!]!;
  },
});

const documents = flat({ 'tax.xlsx': randomBytes(3000), 'draft.tmp': randomBytes(500) });
const appdata = flat({ 'settings.json': Buffer.from('{}') });
const mounted = () =>
  mountSource([
    { path: ['mnt', 'user', 'documents'], source: documents },
    { path: ['mnt', 'user', 'appdata'], source: appdata },
    { path: ['srv', 'notes'], source: flat({ 'todo.txt': Buffer.from('milk') }) },
  ]);

describe('mountSource', () => {
  it('shows each folder at its own path, with only the folders that lead there above it', async () => {
    const source = mounted();
    expect((await source.list([])).map((entry) => entry.name).sort()).toEqual(['mnt', 'srv']);
    expect((await source.list(['mnt'])).map((entry) => entry.name)).toEqual(['user']);
    expect((await source.list(['mnt', 'user'])).map((entry) => entry.name).sort()).toEqual(['appdata', 'documents']);
    expect((await source.list(['mnt', 'user', 'documents'])).map((entry) => entry.name)).toEqual([
      'tax.xlsx',
      'draft.tmp',
    ]);
    expect(await source.list(['elsewhere'])).toEqual([]);
  });

  it('refuses a folder inside another, which would back the same files up twice', () => {
    expect(() =>
      mountSource([
        { path: ['mnt', 'user'], source: documents },
        { path: ['mnt', 'user', 'documents'], source: documents },
      ]),
    ).toThrow('inside another');
  });

  it('backs up as one tree, reports progress, and leaves out what is skipped', async () => {
    const source = filterSource(mounted(), (path) => path.at(-1)!.endsWith('.tmp'));
    expect(await measureSource(source)).toEqual({ files: 3, bytes: 3000 + 2 + 4 });

    const repository = await Repository.init(memoryStore(), {
      rootKey: randomBytes(32),
      chunker: { min: 1024, avg: 4096, max: 16_384 },
    });
    const seen: number[] = [];
    const { snapshot } = await backup(repository, source, { onProgress: (progress) => seen.push(progress.bytes) });
    expect(seen.at(-1)).toBe(3006);
    expect(seen).toEqual(seen.toSorted((a, b) => a - b));
    expect((await listFolder(repository, snapshot, ['mnt', 'user', 'documents'])).map((entry) => entry.name)).toEqual([
      'tax.xlsx',
    ]);
    expect((await listFolder(repository, snapshot, ['srv', 'notes'])).map((entry) => entry.name)).toEqual(['todo.txt']);
  });
});
