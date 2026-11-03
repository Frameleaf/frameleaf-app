import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captureSqliteSnapshot } from 'src/library-import/sqlite.js';

describe('SQLite source snapshots', () => {
  let root: string;
  let sourcePath: string;
  let staging: string;
  let source: DatabaseSync;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'frameleaf-sqlite-source-'));
    sourcePath = join(root, 'source.sqlite');
    staging = join(root, 'staging');
    await mkdir(staging);
    source = new DatabaseSync(sourcePath);
    source.exec(
      "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE photos (id INTEGER PRIMARY KEY, caption TEXT); INSERT INTO photos VALUES (1, 'Edited caption')",
    );
  });
  afterEach(async () => {
    source.close();
    await rm(root, { recursive: true, force: true });
  });
  it('captures committed WAL data into an independent standalone file', async () => {
    const snapshot = await captureSqliteSnapshot(sourcePath, staging);
    const independent = join(root, 'standalone.sqlite');
    await writeFile(independent, await readFile(snapshot.path));
    const copy = new DatabaseSync(independent, { readOnly: true });
    try {
      expect(copy.prepare('SELECT caption FROM photos WHERE id=1').get()?.caption).toBe('Edited caption');
    } finally {
      copy.close();
    }
    expect(snapshot.schemaSha256).toMatch(/^[a-f\d]{64}$/u);
  });
  it('does not change source database or WAL bytes', async () => {
    const before = await Promise.all([readFile(sourcePath), readFile(`${sourcePath}-wal`)]);
    await captureSqliteSnapshot(sourcePath, staging);
    expect(await readFile(sourcePath)).toEqual(before[0]);
    expect(await readFile(`${sourcePath}-wal`)).toEqual(before[1]);
  });
  it('uses private distinct destinations and never overwrites earlier snapshots', async () => {
    const first = await captureSqliteSnapshot(sourcePath, staging);
    const second = await captureSqliteSnapshot(sourcePath, staging);
    expect(second.path).not.toBe(first.path);
    expect((await stat(first.path)).mode & 0o777).toBe(0o600);
    expect(await readFile(first.path)).toEqual(await readFile(second.path));
    expect(second.schemaSha256).toBe(first.schemaSha256);
  });
  it('changes the schema fingerprint when source structure changes', async () => {
    const first = await captureSqliteSnapshot(sourcePath, staging);
    source.exec('ALTER TABLE photos ADD COLUMN favorite INTEGER');
    const second = await captureSqliteSnapshot(sourcePath, staging);
    expect(second.schemaSha256).not.toBe(first.schemaSha256);
  });
  it('rejects corrupt sources without exposing filesystem details or leaving partial snapshots', async () => {
    const corrupt = join(root, 'corrupt.sqlite');
    await writeFile(corrupt, 'not a sqlite database');
    await expect(captureSqliteSnapshot(corrupt, staging)).rejects.toThrow('SQLITE_SNAPSHOT_FAILED');
    expect(await readdir(staging)).toEqual([]);
  });
  it('refuses snapshots with broken foreign keys', async () => {
    source.exec(
      'PRAGMA foreign_keys=OFF; CREATE TABLE albums(id INTEGER PRIMARY KEY); CREATE TABLE membership(photo INTEGER REFERENCES photos(id),album INTEGER REFERENCES albums(id)); INSERT INTO membership VALUES(1,999)',
    );
    await expect(captureSqliteSnapshot(sourcePath, staging)).rejects.toThrow('SQLITE_SNAPSHOT_FAILED');
    expect(await readdir(staging)).toEqual([]);
  });
});
