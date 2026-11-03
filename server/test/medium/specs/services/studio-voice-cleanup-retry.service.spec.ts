import { Kysely, sql } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { DB } from 'src/schema/index.js';
import type { FilePort, PreparedImport, PublicationKey } from 'src/utils/studio-import-publication.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { StudioImportPublicationRepository } from 'src/repositories/studio-import-publication.repository.js';
import { StudioProjectRepository } from 'src/repositories/studio-project.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { StudioImportPublicationService, retainImport } from 'src/services/studio-import-publication.service.js';
import { StudioVoiceCleanupService } from 'src/services/studio-voice-cleanup.service.js';
import { DECLARATION } from 'test/fixtures/studio-import-retention.js';
import { getLibraryQueueDB as createRetentionTestDatabase } from 'test/medium/library-queue-database.js';
import { newMediumService } from 'test/medium.factory.js';

// Owner decision 2026-10-31: a voice clean-up retry supersedes its own unfinished import in the publication
// journal. Real journal SQL on disposable Postgres; the file barriers are modelled on temporary files.
let db: Kysely<DB>;
let root: string;
beforeAll(async () => {
  db = await createRetentionTestDatabase();
  root = await mkdtemp(join(tmpdir(), 'fl722-voice-retry-'));
});
afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  await db?.destroy();
});

const absent = async (path: string) => {
  await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
};

/** The FilePort the import service uses, modelled on temporary files; `failPublish` stops after the link. */
const filePort = (failPublish = false): FilePort => ({
  prepare: () => Promise.reject(new Error('prepared by the test')),
  publish: async (file) => {
    await link(file.stagedPath, file.targetPath);
    if (failPublish) throw new Error('worker stopped before the import was recorded');
  },
  release: async (owned, role) => {
    for (const path of role === 'stage' ? [owned.stagedPath] : [owned.targetPath, owned.stagedPath])
      await rm(path, { force: true });
  },
});

const setup = async () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const { user } = await ctx.newUser();
  const projects = ctx.get(StudioProjectRepository);
  const project = await projects.create({ ownerId: user.id, name: 'Voice clean-up retry' });
  const journal = new StudioImportPublicationRepository(db);
  const studio = { requireOwnedProject: () => Promise.resolve(project) };
  const publications = new StudioImportPublicationService(journal, filePort() as never, studio as never);
  const sut = new StudioVoiceCleanupService(
    { setContext: () => {} } as never,
    null as never,
    projects,
    studio as never,
    null as never,
    null as never,
    publications,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
  );
  const supersede = (importId: string) =>
    (
      sut as unknown as { supersede: (auth: AuthDto, projectId: string, importId: string) => Promise<unknown> }
    ).supersede({ user: { id: user.id } } as AuthDto, project.id, importId);
  const importId = randomUUID();

  /** One attempt as `StudioProjectImportService.upload` makes it: a fresh publication, then retention. */
  const attempt = async (bytes: string, options: { importId?: string; failPublish?: boolean } = {}) => {
    const key: PublicationKey = {
      ownerId: user.id,
      projectId: project.id,
      importId: options.importId ?? importId,
      publicationId: randomUUID(),
    };
    await journal.register(key);
    const stagedPath = join(root, `${randomUUID()}.upload`);
    await writeFile(stagedPath, bytes, { flag: 'wx', mode: 0o600 });
    const stat = await lstat(stagedPath, { bigint: true });
    const file: PreparedImport = {
      stagedPath,
      targetPath: join(root, `${key.projectId}-${key.importId}.m4a`),
      identity: { dev: String(stat.dev), ino: String(stat.ino), size: Number(stat.size) },
      declaration: {
        ...DECLARATION,
        contentType: 'audio/mp4',
        extension: '.m4a',
        fileName: 'Beach walk (cleaned voice).m4a',
        sizeBytes: Buffer.byteLength(bytes),
        checksum: createHash('sha256').update(bytes).digest('hex'),
        processingProvenance: null,
      },
    };
    const files = { ...filePort(options.failPublish), prepare: () => Promise.resolve(file) };
    const retained = retainImport(journal, files, { key, incoming: stagedPath, declaration: file.declaration });
    return { key, file, retained };
  };
  const imports = async (id: string = importId) =>
    (
      await sql<{ checksum: string; path: string }>`SELECT checksum,path FROM public.studio_project_import
        WHERE "projectId"=${project.id}::uuid AND id=${id}::uuid`.execute(db)
    ).rows;
  return { journal, supersede, attempt, imports, importId };
};

describe('voice clean-up retry against the real publication journal', () => {
  it('a retry after a failed attempt supersedes it and leaves one published track with no leftovers', async () => {
    const { journal, supersede, attempt, imports } = await setup();
    const first = await attempt('first encoding', { failPublish: true });
    await expect(first.retained).rejects.toThrow('worker stopped');
    expect(await journal.get(first.key)).toMatchObject({ state: 'preparing', cleanupPending: true });

    // Without superseding, the journal refuses the re-encoded bytes for the same import.
    const refused = await attempt('second encoding');
    await expect(refused.retained).rejects.toThrow('publication_busy');

    await expect(supersede(first.key.importId)).resolves.toBeUndefined();
    expect(await journal.get(first.key)).toMatchObject({ state: 'aborted', cleanupPending: false });
    await absent(first.file.stagedPath);
    await absent(first.file.targetPath);

    const retry = await attempt('second encoding');
    await expect(retry.retained).resolves.toMatchObject({ id: retry.key.importId });
    expect(await journal.get(retry.key)).toMatchObject({ state: 'published', cleanupPending: false });
    const rows = await imports();
    expect(rows).toEqual([{ checksum: retry.file.declaration.checksum, path: retry.file.targetPath }]);
    expect(await readFile(retry.file.targetPath, 'utf8')).toBe('second encoding');
    await absent(retry.file.stagedPath);
    // The refused attempt's publication, registered but never staged, was superseded too.
    expect(await journal.get(refused.key)).toMatchObject({ state: 'aborted', cleanupPending: false });
  });

  it('a retry after a success reuses the finished import and keeps no second row', async () => {
    const { journal, supersede, attempt, imports, importId } = await setup();
    const done = await attempt('finished encoding');
    await done.retained;

    await expect(supersede(importId)).resolves.toMatchObject({
      id: importId,
      checksum: done.file.declaration.checksum,
      contentType: 'audio/mp4',
    });

    expect(await journal.get(done.key)).toMatchObject({ state: 'published', cleanupPending: false });
    expect(await imports()).toHaveLength(1);
    expect(await readFile(done.file.targetPath, 'utf8')).toBe('finished encoding');
  });

  it("never touches another import's publication", async () => {
    const { journal, supersede, attempt, imports, importId } = await setup();
    const other = await attempt('another import', { importId: randomUUID(), failPublish: true });
    await expect(other.retained).rejects.toThrow('worker stopped');

    await expect(supersede(importId)).resolves.toBeUndefined();

    expect(await journal.get(other.key)).toMatchObject({ state: 'preparing', cleanupPending: true });
    expect(await readFile(other.file.stagedPath, 'utf8')).toBe('another import');
    expect(await readFile(other.file.targetPath, 'utf8')).toBe('another import');
    expect(await imports(other.key.importId)).toHaveLength(0);
  });
});
