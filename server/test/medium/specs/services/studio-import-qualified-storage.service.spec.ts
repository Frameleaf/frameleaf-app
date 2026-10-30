import { Kysely, sql } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DB } from 'src/schema/index.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { StorageFolder } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { StudioImportFileRepository, StudioStorageRefusal } from 'src/repositories/studio-import-file.repository.js';
import { StudioImportPublicationRepository } from 'src/repositories/studio-import-publication.repository.js';
import { StudioProjectRepository } from 'src/repositories/studio-project.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { retainImport } from 'src/services/studio-import-publication.service.js';
import { DECLARATION } from 'test/fixtures/studio-import-retention.js';
import { getLibraryQueueDB as createRetentionTestDatabase } from 'test/medium/library-queue-database.js';
import { newMediumService } from 'test/medium.factory.js';

// FL-682: the production file repository, with its default qualification, on real Linux storage and real journal SQL.
let db: Kysely<DB>;
let media: string;
let previousMedia: string | undefined;
beforeAll(async () => {
  db = await createRetentionTestDatabase();
  media = await mkdtemp(join(tmpdir(), 'fl682-media-'));
  try {
    previousMedia = StorageCore.getMediaLocation();
  } catch {
    previousMedia = undefined;
  }
  StorageCore.setMediaLocation(media);
});
afterAll(async () => {
  if (previousMedia === undefined) StorageCore.reset();
  else StorageCore.setMediaLocation(previousMedia);
  if (media) await rm(media, { recursive: true, force: true });
  await db?.destroy();
});

const upload = async (bytes: Buffer) => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const { user } = await ctx.newUser();
  const project = await ctx.get(StudioProjectRepository).create({ ownerId: user.id, name: 'Qualified import' });
  const key = { ownerId: user.id, projectId: project.id, importId: randomUUID(), publicationId: randomUUID() };
  const journal = new StudioImportPublicationRepository(db);
  await journal.register(key);
  const incoming = join(StorageCore.getFolderLocation(StorageFolder.Exports, user.id), 'studio-imports', 'incoming');
  await mkdir(incoming, { recursive: true, mode: 0o755 });
  const staged = join(incoming, `${randomUUID()}.upload`);
  await writeFile(staged, bytes, { flag: 'wx', mode: 0o644 });
  const checksum = createHash('sha256').update(bytes).digest('hex');
  const declaration = {
    ...DECLARATION,
    sizeBytes: bytes.length,
    checksum,
    processingProvenance: null,
  };
  return { key, journal, staged, upload: { key, incoming: staged, declaration } };
};

describe.runIf(platform() === 'linux')('Studio import on qualified exports storage', () => {
  it('stages <uuid>.upload, publishes it into the project and cleans up the stage', async () => {
    const bytes = Buffer.from('frameleaf studio import');
    const { key, journal, staged, upload: retention } = await upload(bytes);

    const imported = await retainImport(journal, new StudioImportFileRepository(), retention);

    expect(imported).toMatchObject({ id: key.importId, checksum: retention.declaration.checksum });
    const target = join(StorageCore.getBaseFolder(StorageFolder.Exports), key.ownerId, 'studio-imports', key.projectId);
    expect(await readFile(join(target, `${key.importId}.mp4`))).toEqual(bytes);
    await expect(stat(staged)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await journal.get(key))?.state).toBe('published');
    const { rows } = await sql`SELECT id FROM public.studio_project_import WHERE id=${key.importId}::uuid`.execute(db);
    expect(rows).toHaveLength(1);
    // The qualification probe leaves nothing behind in the exports root.
    expect(
      (await readdir(StorageCore.getBaseFolder(StorageFolder.Exports))).filter((name) => name.startsWith('.')),
    ).toEqual([]);
  });

  it('refuses with a retail message when the exports root is writable by other users', async () => {
    const exports = StorageCore.getBaseFolder(StorageFolder.Exports);
    const { journal, upload: retention } = await upload(Buffer.from('shared'));
    await chmod(exports, 0o777);
    try {
      const refusal = retainImport(journal, new StudioImportFileRepository(), retention);
      await expect(refusal).rejects.toBeInstanceOf(StudioStorageRefusal);
      await expect(refusal).rejects.toThrow("Studio can't safely keep files in this storage location");
    } finally {
      await chmod(exports, 0o755);
    }
  });
});
