import { Kysely, Transaction, sql } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rmdir,
  symlink,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DB } from 'src/schema/index.js';
import type { ImportDeclaration, PreparedImport, PublicationKey } from 'src/utils/studio-import-publication.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { MediaOperationDestination, MediaOperationKind, MediaOperationStatus } from 'src/enum.js';
import { BuddyBackupStudioRepository } from 'src/repositories/buddy-backup-studio.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { BUDDY_CAPTURE_LOCK, countPathReferences, lockFilePath } from 'src/repositories/physical-file.repository.js';
import { StudioImportPublicationRepository } from 'src/repositories/studio-import-publication.repository.js';
import { StudioProjectRepository } from 'src/repositories/studio-project.repository.js';
import { assertStudioStorageAdmission } from 'src/repositories/studio-storage-admission.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { STUDIO_IMPORT_MAX_PER_PROJECT } from 'src/utils/studio-imports.js';
import { DECLARATION } from 'test/fixtures/studio-import-retention.js';
import { getLibraryQueueDB as createRetentionTestDatabase } from 'test/medium/library-queue-database.js';
import { newMediumService } from 'test/medium.factory.js';

let db: Kysely<DB>;
let root: string;
const ownedFiles = new Set<string>();
const ownedDirectories = new Set<string>();

beforeAll(async () => {
  db = await createRetentionTestDatabase();
  root = await mkdtemp(join(tmpdir(), 'fl111-journal-'));
});

afterAll(async () => {
  try {
    for (const path of ownedFiles) {
      await unlink(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
    for (const directory of [...ownedDirectories].sort((a, b) => b.length - a.length)) await rmdir(directory);
    if (root) await rmdir(root);
  } finally {
    // The existing helper closes its bounded pool and drops only its own generated clone.
    await db?.destroy();
  }
});

const setup = async () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const { user } = await ctx.newUser();
  const projects = ctx.get(StudioProjectRepository);
  const project = await projects.create({ ownerId: user.id, name: 'Retention journal acceptance' });
  const key = { ownerId: user.id, projectId: project.id, importId: randomUUID(), publicationId: randomUUID() };
  return { ctx, user, projects, project, key, repo: new StudioImportPublicationRepository(db) };
};

const file = async (key: PublicationKey, changes: Partial<ImportDeclaration> = {}): Promise<PreparedImport> => {
  const stagedPath = join(root, `${randomUUID()}.stage`);
  const targetPath = join(root, `${key.projectId}-${key.importId}.mp4`);
  const bytes = Buffer.from('test');
  await writeFile(stagedPath, bytes, { flag: 'wx', mode: 0o600 });
  ownedFiles.add(stagedPath);
  ownedFiles.add(targetPath);
  const stat = await lstat(stagedPath, { bigint: true });
  const checksum = createHash('sha256').update(bytes).digest('hex');
  return {
    stagedPath,
    targetPath,
    identity: { dev: String(stat.dev), ino: String(stat.ino), size: Number(stat.size) },
    declaration: {
      ...structuredClone(DECLARATION),
      checksum,
      processingProvenance: { ...structuredClone(DECLARATION.processingProvenance), outputSha256: checksum },
      ...changes,
    },
  };
};

// These callbacks model an acknowledged file barrier for DB tests; they do not qualify storage durability.
const linkFile = async (prepared: PreparedImport) => {
  await link(prepared.stagedPath, prepared.targetPath);
};
const removeFile = async (prepared: PreparedImport, role: 'stage' | 'aborted') => {
  for (const path of role === 'stage' ? [prepared.stagedPath] : [prepared.stagedPath, prepared.targetPath]) {
    await unlink(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
};

const journal = async (key: PublicationKey) => {
  const { rows } = await sql<{
    id: string;
    ownerId: string;
    projectId: string;
    importId: string;
    state: string;
    createdAt: Date;
    expiresAt: Date;
    stagedPath: string | null;
    targetPath: string | null;
    declaration: ImportDeclaration | null;
    stagedIdentity: PreparedImport['identity'] | null;
  }>`SELECT * FROM public.studio_import_publication WHERE id=${key.publicationId}::uuid`.execute(db);
  return rows[0];
};
const ready = async (key: PublicationKey) =>
  (
    await sql<{
      id: string;
      path: string;
      checksum: string;
      processingProvenance: unknown;
    }>`SELECT id,path,checksum,"processingProvenance" FROM public.studio_project_import
  WHERE "projectId"=${key.projectId}::uuid AND id=${key.importId}::uuid`.execute(db)
  ).rows;

const prepare = async (fixture: Awaited<ReturnType<typeof setup>>, changes: Partial<ImportDeclaration> = {}) => {
  const prepared = await file(fixture.key, changes);
  await fixture.repo.register(fixture.key);
  await fixture.repo.prepare(fixture.key, prepared, removeScratch);
  return prepared;
};
const removeScratch = async (prepared: PreparedImport) => {
  await unlink(prepared.stagedPath);
};
const expire = async (key: PublicationKey) => {
  // Fixture clock setup preserves the real six-hour CHECK and never synthesizes a transition.
  await sql`WITH stamp AS (SELECT clock_timestamp()-interval '1 second' AS expired)
    UPDATE public.studio_import_publication SET "createdAt"=stamp.expired-interval '6 hours',
    "expiresAt"=stamp.expired FROM stamp WHERE id=${key.publicationId}::uuid`.execute(db);
};
const defer = () => Promise.withResolvers<void>();
const waitForCallback = async (entered: Promise<void>, operation: Promise<unknown>) => {
  await Promise.race([
    entered,
    operation.then(() => {
      throw new Error('Expected callback was not entered');
    }),
  ]);
};
const pathKey = (path: string) => createHash('sha1').update(path).digest().readBigInt64BE(0).toString();

const blockedOperation = async (
  take: (tx: Transaction<DB>) => Promise<unknown>,
  operation: () => Promise<unknown>,
  inspect: (tx: Transaction<DB>, pid: number) => Promise<void> = () => Promise.resolve(),
) => {
  let pending: Promise<{ error?: unknown }> | undefined;
  let blockerFailure: { error: unknown } | undefined;
  await db
    .transaction()
    .execute(async (tx) => {
      await take(tx);
      pending = operation()
        .then(() => ({}))
        .catch((error: unknown) => ({ error }));
      let pid: number | undefined;
      // Observe actual lock waiting through the blocker connection; do not add a third pool connection.
      for (let attempt = 0; attempt < 100; attempt++) {
        const result = await sql<{ pid: number }>`SELECT pid FROM pg_stat_activity
          WHERE datname=current_database() AND pid<>pg_backend_pid()
            AND pg_backend_pid()=ANY(pg_blocking_pids(pid))`.execute(tx);
        pid = result.rows[0]?.pid;
        if (pid) break;
        await new Promise((done) => setTimeout(done, 10));
      }
      expect(pid, 'Repository operation must actually wait on the held SQL lock').toBeDefined();
      await inspect(tx, pid!);
    })
    .catch((error: unknown) => {
      blockerFailure = { error };
    });
  // Drain after the blocker settles; retain the previous operation-error precedence.
  const outcome = await pending;
  if (outcome?.error) throw outcome.error;
  if (blockerFailure) throw blockerFailure.error;
};
const projectLockHeld = async (tx: Transaction<DB>, projectId: string) => {
  const { rows } = await sql<{ available: boolean }>`SELECT pg_try_advisory_xact_lock(
    hashtextextended(${`buddy-studio:${projectId}`},0)) AS available`.execute(tx);
  expect(rows[0].available).toBe(false);
};

// No journal transitions are emulated with SQL. Every register/prepare/publish/cancel/release calls the real repository.
describe('Studio import publication — real journal SQL acceptance', () => {
  it('atomically transfers the exact request reservation without double-counting its quota', async () => {
    const f = await setup();
    const scratch = await file(f.key);
    await db
      .updateTable('user')
      .set({ quotaSizeInBytes: 4, quotaUsageInBytes: 0 })
      .where('id', '=', f.user.id)
      .execute();
    const reservation = await f.projects.createUpload({
      ownerId: f.user.id,
      path: scratch.stagedPath,
      sizeBytes: 4,
      digest: '',
      originalFileName: '',
      manifest: {},
      expiresAt: new Date(Date.now() + 60_000),
    });
    await f.repo.register(f.key);
    const outcomes = await Promise.allSettled([
      f.repo.prepare(f.key, scratch, removeScratch, reservation.id),
      f.projects.createUpload({
        ownerId: f.user.id,
        path: `${scratch.stagedPath}.other`,
        sizeBytes: 1,
        digest: '',
        originalFileName: '',
        manifest: {},
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ]);
    expect(outcomes[0]).toMatchObject({ status: 'fulfilled', value: { status: 'prepared' } });
    expect(outcomes[1]).toMatchObject({ status: 'rejected' });
    expect(await f.projects.getUpload(reservation.id, f.user.id)).toBeUndefined();
    expect((await journal(f.key)).stagedPath).toBe(scratch.stagedPath);
    // Models a positively reconciled committed-but-lost prepare acknowledgement, not transport qualification.
    await expect(f.repo.prepare(f.key, scratch, removeScratch, reservation.id)).resolves.toMatchObject({
      status: 'prepared',
    });
    await expect(
      f.projects.createUpload({
        ownerId: f.user.id,
        path: `${scratch.stagedPath}.other`,
        sizeBytes: 1,
        digest: '',
        originalFileName: '',
        manifest: {},
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).rejects.toThrow(/quota/i);
  });
  it.each(['foreign-owner', 'foreign-path', 'small', 'expired', 'nonempty-digest'] as const)(
    'rolls back an invalid request reservation transfer: %s',
    async (change) => {
      const f = await setup();
      const scratch = await file(f.key);
      const foreign = change === 'foreign-owner' ? await setup() : f;
      const reservation = await foreign.projects.createUpload({
        ownerId: foreign.user.id,
        path: change === 'foreign-path' ? `${scratch.stagedPath}.foreign` : scratch.stagedPath,
        sizeBytes: change === 'small' ? 1 : 4,
        digest: change === 'nonempty-digest' ? 'ab' : '',
        originalFileName: '',
        manifest: {},
        expiresAt: new Date(Date.now() + (change === 'expired' ? -60_000 : 60_000)),
      });
      await f.repo.register(f.key);
      await expect(f.repo.prepare(f.key, scratch, removeScratch, reservation.id)).rejects.toThrow(
        'publication_reservation_conflict',
      );
      expect(await foreign.projects.getUpload(reservation.id, foreign.user.id)).toBeDefined();
      expect((await journal(f.key)).state).toBe('registered');
      expect(await readFile(scratch.stagedPath, 'utf8')).toBe('test');
    },
  );
  it('keeps the request reservation and scratch when receipt expiry aborts before ownership transfer', async () => {
    const f = await setup();
    const scratch = await file(f.key);
    const reservation = await f.projects.createUpload({
      ownerId: f.user.id,
      path: scratch.stagedPath,
      sizeBytes: 4,
      digest: '',
      originalFileName: '',
      manifest: {},
      expiresAt: new Date(Date.now() + 60_000),
    });
    await f.repo.register(f.key);
    await expire(f.key);
    await expect(f.repo.prepare(f.key, scratch, removeScratch, reservation.id)).rejects.toThrow('publication_expired');
    expect(await f.projects.getUpload(reservation.id, f.user.id)).toBeDefined();
    expect((await journal(f.key)).state).toBe('aborted');
    expect((await journal(f.key)).stagedPath).toBeNull();
    expect(await readFile(scratch.stagedPath, 'utf8')).toBe('test');
  });
  it('refuses a different live reservation when reconciling an existing prepared stage', async () => {
    const f = await setup(),
      foreign = await setup();
    const scratch = await prepare(f);
    const reservation = await foreign.projects.createUpload({
      ownerId: foreign.user.id,
      path: scratch.stagedPath,
      sizeBytes: 4,
      digest: '',
      originalFileName: '',
      manifest: {},
      expiresAt: new Date(Date.now() + 60_000),
    });
    await expect(f.repo.prepare(f.key, scratch, removeScratch, reservation.id)).rejects.toThrow(
      'publication_reservation_conflict',
    );
    expect(await foreign.projects.getUpload(reservation.id, foreign.user.id)).toBeDefined();
    expect(await readFile(scratch.stagedPath, 'utf8')).toBe('test');
  });
  it('refuses reusing another publication request stage after ownership transfer', async () => {
    const f = await setup();
    const original = await prepare(f);
    const second = { ...f.key, importId: randomUUID(), publicationId: randomUUID() };
    await f.repo.register(second);
    await expect(
      f.repo.prepare(second, { ...original, targetPath: `${original.targetPath}.other` }, removeScratch),
    ).rejects.toThrow(/referenced/i);
    expect(await readFile(original.stagedPath, 'utf8')).toBe('test');
    expect((await journal(f.key)).stagedPath).toBe(original.stagedPath);
  });

  it('T4-01 cancellation before registration commits an irreversible compact tombstone', async () => {
    const f = await setup();
    expect((await f.repo.cancel(f.key)).status).toBe('cancelled');
    expect(await journal(f.key)).toMatchObject({
      state: 'aborted',
      stagedPath: null,
      targetPath: null,
      declaration: null,
    });
    await expect(f.repo.register(f.key)).rejects.toThrow('publication_aborted');
    const scratch = await file(f.key);
    await expect(f.repo.prepare(f.key, scratch, removeScratch)).rejects.toThrow('publication_aborted');
    expect(await ready(f.key)).toEqual([]);
  });

  it('T4-02 concurrent matching registration retains one binding and fixed six-hour expiry', async () => {
    const f = await setup();
    const receipts = await Promise.all([f.repo.register(f.key), f.repo.register(f.key)]);
    expect(receipts[0]).toEqual(receipts[1]);
    const before = (await journal(f.key))!;
    expect(before.expiresAt.getTime() - before.createdAt.getTime()).toBe(6 * 60 * 60 * 1000);
    await f.repo.register(f.key);
    expect(await journal(f.key)).toEqual(before);
    expect((await f.repo.discover(f.user.id, f.project.id)).items).toHaveLength(1);
  });

  it.each(['ownerId', 'projectId', 'importId'] as const)(
    'T4-03 refuses changed %s for an established publication ID',
    async (field) => {
      const f = await setup();
      const other = await setup();
      await f.repo.register(f.key);
      const before = await journal(f.key);
      const changed = {
        ...f.key,
        [field]: field === 'ownerId' ? other.user.id : field === 'projectId' ? other.project.id : randomUUID(),
      };
      await expect(f.repo.register(changed)).rejects.toThrow();
      await expect(f.repo.prepare(changed, await file(changed), removeScratch)).rejects.toThrow();
      await expect(f.repo.cancel(changed)).rejects.toThrow();
      expect(await journal(f.key)).toEqual(before);
    },
  );

  it('T4-04 rechecks owner authority on registration, exact query and every discovery page', async () => {
    const f = await setup();
    const other = await setup();
    await f.repo.register(f.key);
    await expect(f.repo.register({ ...f.key, ownerId: other.user.id, publicationId: randomUUID() })).rejects.toThrow();
    await expect(f.repo.get({ ...f.key, ownerId: other.user.id })).rejects.toThrow();
    await expect(f.repo.discover(other.user.id, f.project.id)).rejects.toThrow();
    expect(await f.repo.get(f.key)).toMatchObject({ publicationId: f.key.publicationId, state: 'registered' });
    expect(await f.projects.listImports(f.project.id)).toEqual([]);
  });

  it.each(['archived', 'trashed', 'owner-deleted'] as const)(
    'T4-05 rechecks %s after registration and before final callback',
    async (state) => {
      const f = await setup();
      await prepare(f);
      switch (state) {
        case 'archived': {
          await f.projects.update(f.project.id, { archivedAt: new Date() });
          break;
        }
        case 'trashed': {
          await f.projects.trash(f.project.id, new Date(Date.now() + 60_000));
          break;
        }
        case 'owner-deleted': {
          await f.ctx.get(UserRepository).delete({ id: f.user.id });
          // No default
          break;
        }
      }
      const link = vi.fn(linkFile);
      await expect(f.repo.publish(f.key, link)).rejects.toThrow();
      expect(link).not.toHaveBeenCalled();
      expect(await ready(f.key)).toEqual([]);
      expect(await journal(f.key)).toMatchObject({ state: 'preparing' });
    },
  );

  it('T4-06 two registered IDs for one import cannot both reserve a preparing intent', async () => {
    const f = await setup();
    const next = { ...f.key, publicationId: randomUUID() };
    await Promise.all([f.repo.register(f.key), f.repo.register(next)]);
    const a = await file(f.key),
      b = await file(next);
    const attempts = await Promise.allSettled([
      f.repo.prepare(f.key, a, removeScratch),
      f.repo.prepare(next, b, removeScratch),
    ]);
    expect(attempts.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const { rows } = await sql<{ count: number }>`SELECT count(*)::int AS count FROM public.studio_import_publication
      WHERE "projectId"=${f.project.id}::uuid AND "importId"=${f.key.importId}::uuid AND state='preparing'`.execute(db);
    expect(rows[0].count).toBe(1);
    expect(await ready(f.key)).toEqual([]);
  });

  it('T4-07 matching prepare retries keep original handles and discard only the new scratch', async () => {
    const f = await setup();
    const original = await prepare(f);
    const duplicate = await file(f.key);
    const discard = vi.fn(removeScratch);
    const result = await f.repo.prepare(f.key, duplicate, discard);
    expect(result).toEqual({ status: 'prepared', file: original });
    expect(discard).toHaveBeenCalledExactlyOnceWith(duplicate);
    expect(await lstat(original.stagedPath)).toBeDefined();
    expect(await journal(f.key)).toMatchObject({
      stagedPath: original.stagedPath,
      targetPath: original.targetPath,
      stagedIdentity: original.identity,
    });
  });

  it.each([
    ['checksum', { checksum: 'c'.repeat(64) }],
    ['size', { sizeBytes: 5 }],
    ['type', { contentType: 'audio/wav' }],
    ['extension', { extension: '.wav' }],
    ['name', { fileName: 'other.mp4' }],
    ['external references', { externalReferences: 1 }],
    ['provenance', { processingProvenance: null }],
  ] satisfies Array<[string, Partial<ImportDeclaration>]>)(
    'T4-08 refuses a changed full declaration: %s',
    async (_name, change) => {
      const f = await setup();
      const original = await prepare(f);
      const discard = vi.fn(removeScratch);
      await expect(f.repo.prepare(f.key, await file(f.key, change), discard)).rejects.toThrow();
      expect(discard).not.toHaveBeenCalled();
      expect(await journal(f.key)).toMatchObject({
        stagedPath: original.stagedPath,
        declaration: original.declaration,
      });
    },
  );

  it('T4-09 JSONB key order does not change immutable matching provenance', async () => {
    const f = await setup();
    const original = await prepare(f);
    const retry = await file(f.key);
    const lineage = retry.declaration.processingProvenance!;
    retry.declaration.processingProvenance = Object.fromEntries(Object.entries(lineage).toReversed()) as typeof lineage;
    await expect(f.repo.prepare(f.key, retry, removeScratch)).resolves.toEqual({ status: 'prepared', file: original });
  });

  it('T4-10 final callback precedes one atomic ready-import and published-journal commit', async () => {
    const f = await setup();
    const prepared = await prepare(f);
    await f.repo.publish(f.key, async (value) => {
      expect(value).toEqual(prepared);
      expect(await ready(f.key)).toEqual([]);
      expect(await journal(f.key)).toMatchObject({ state: 'preparing' });
      expect(await f.projects.listImports(f.project.id)).toEqual([]);
      await linkFile(value);
    });
    expect(await ready(f.key)).toEqual([
      expect.objectContaining({
        id: f.key.importId,
        path: prepared.targetPath,
        processingProvenance: prepared.declaration.processingProvenance,
      }),
    ]);
    expect(await journal(f.key)).toMatchObject({ state: 'published', stagedPath: prepared.stagedPath });
    expect((await f.repo.get(f.key))!.cleanupPending).toBe(true);
  });

  it('T4-11 link/barrier rejection rolls back ready insertion and preserves exact preparing evidence', async () => {
    const f = await setup();
    const prepared = await prepare(f);
    await expect(f.repo.publish(f.key, () => Promise.reject(new Error('target-barrier-failed')))).rejects.toThrow(
      'target-barrier-failed',
    );
    expect(await ready(f.key)).toEqual([]);
    expect(await journal(f.key)).toMatchObject({
      state: 'preparing',
      stagedPath: prepared.stagedPath,
      stagedIdentity: prepared.identity,
    });
  });

  it('T4-12 a lost postcommit acknowledgement reconciles the actual ready row without linking twice', async () => {
    const f = await setup();
    await prepare(f);
    await expect(
      (async () => {
        await f.repo.publish(f.key, linkFile);
        throw new Error('ack-lost');
      })(),
    ).rejects.toThrow('ack-lost');
    const retryLink = vi.fn(linkFile);
    const imported = await f.repo.publish(f.key, retryLink);
    expect(imported.id).toBe(f.key.importId);
    expect(retryLink).not.toHaveBeenCalled();
    expect(await ready(f.key)).toHaveLength(1);
    expect((await f.repo.cancel(f.key)).status).toBe('already-published');
    expect(await ready(f.key)).toHaveLength(1);
  });

  it('T4-13 a new-ID ready retry creates its own published receipt without rebinding the ready row', async () => {
    const f = await setup();
    const original = await prepare(f);
    await f.repo.publish(f.key, linkFile);
    const next = { ...f.key, publicationId: randomUUID() };
    await f.repo.register(next);
    const scratch = await file(next);
    const result = await f.repo.prepare(next, scratch, removeScratch);
    expect(result).toMatchObject({ status: 'ready', imported: { id: f.key.importId, path: original.targetPath } });
    expect(await journal(next)).toMatchObject({ state: 'published' });
    expect(await ready(next)).toHaveLength(1);
  });

  it.each([
    ['cleanup-failed', 'omitted-provenance'],
    ['cleanup-failed', 'changed-label'],
    ['cleanup-failed', 'both'],
    ['lost-final-ack', 'omitted-provenance'],
    ['lost-final-ack', 'changed-label'],
    ['lost-final-ack', 'both'],
  ] as const)('T5-R2 same-publication ready retry after %s: %s', async (outcome, variation) => {
    const f = await setup();
    const original = await prepare(f);
    if (outcome === 'lost-final-ack') {
      await expect(
        f.repo.publish(f.key, linkFile).then(() => {
          throw new Error('model_lost_final_ack');
        }),
      ).rejects.toThrow('model_lost_final_ack');
    } else {
      await f.repo.publish(f.key, linkFile);
      await expect(f.repo.release(f.key, () => Promise.reject(new Error('model_cleanup_failed')))).rejects.toThrow(
        'model_cleanup_failed',
      );
    }
    const before = await ready(f.key);
    expect(await f.repo.get(f.key)).toMatchObject({ state: 'published', cleanupPending: true });
    const scratch = await file(f.key, {
      ...(variation !== 'changed-label' && { processingProvenance: null }),
      ...(variation !== 'omitted-provenance' && { fileName: 'retry-label.mp4' }),
    });
    const reservation = await f.projects.createUpload({
      ownerId: f.user.id,
      path: scratch.stagedPath,
      sizeBytes: scratch.declaration.sizeBytes,
      digest: '',
      originalFileName: '',
      manifest: {},
      expiresAt: new Date(Date.now() + 60_000),
    });
    const discard = vi.fn(removeScratch);
    await expect(f.repo.prepare(f.key, scratch, discard, reservation.id)).resolves.toMatchObject({
      status: 'ready',
      imported: {
        id: f.key.importId,
        path: original.targetPath,
        fileName: original.declaration.fileName,
        processingProvenance: original.declaration.processingProvenance,
      },
    });
    expect(discard).toHaveBeenCalledExactlyOnceWith(scratch);
    await expect(lstat(scratch.stagedPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await lstat(original.stagedPath)).toBeDefined();
    expect(await f.projects.getUpload(reservation.id, f.user.id)).toBeUndefined();
    expect(await journal(f.key)).toMatchObject({ stagedPath: original.stagedPath, declaration: original.declaration });
    expect(await ready(f.key)).toEqual(before);
    await f.repo.release(f.key, removeFile);
    expect(await readFile(original.targetPath, 'utf8')).toBe('test');
  });

  it.each(['different-provenance', 'null-enrichment'] as const)(
    'T5-R2 same-publication ready retry retains supplied lineage conflicts: %s',
    async (variation) => {
      const f = await setup();
      const original = await prepare(f, variation === 'null-enrichment' ? { processingProvenance: null } : {});
      await f.repo.publish(f.key, linkFile);
      const before = await ready(f.key),
        scratch = await file(f.key),
        discard = vi.fn(removeScratch);
      if (variation === 'different-provenance') scratch.declaration.processingProvenance!.variant = 'threeD';
      await expect(f.repo.prepare(f.key, scratch, discard)).rejects.toThrow('provenance_conflict');
      expect(discard).not.toHaveBeenCalled();
      expect(await ready(f.key)).toEqual(before);
      expect(await journal(f.key)).toMatchObject({
        stagedPath: original.stagedPath,
        declaration: original.declaration,
      });
    },
  );

  it.each(['different-provenance', 'null-enrichment', 'omitted-provenance'] as const)(
    'T4-14 ready immutable retry: %s',
    async (kind) => {
      const f = await setup();
      await prepare(f, kind === 'null-enrichment' ? { processingProvenance: null } : {});
      await f.repo.publish(f.key, linkFile);
      const before = await ready(f.key);
      const next = { ...f.key, publicationId: randomUUID() };
      await f.repo.register(next);
      const scratch = await file(next);
      if (kind === 'omitted-provenance') {
        scratch.declaration.processingProvenance = null;
        await expect(f.repo.prepare(next, scratch, removeScratch)).resolves.toMatchObject({ status: 'ready' });
      } else {
        if (kind === 'different-provenance') scratch.declaration.processingProvenance!.variant = 'threeD';
        await expect(f.repo.prepare(next, scratch, removeScratch)).rejects.toThrow('provenance_conflict');
      }

      expect(await ready(f.key)).toEqual(before);
    },
  );

  it.each([{ checksum: 'd'.repeat(64) }, { contentType: 'audio/wav' }, { sizeBytes: 7 }])(
    'T4-15 ready retries refuse changed bytes/type/size %j',
    async (change) => {
      const f = await setup();
      await prepare(f);
      await f.repo.publish(f.key, linkFile);
      const before = await ready(f.key),
        next = { ...f.key, publicationId: randomUUID() };
      await f.repo.register(next);
      const discard = vi.fn(removeScratch);
      await expect(f.repo.prepare(next, await file(next, change), discard)).rejects.toThrow();
      expect(discard).not.toHaveBeenCalled();
      expect(await ready(f.key)).toEqual(before);
    },
  );

  it('T4-16 missing ready bytes refuse repair-required instead of adopting new scratch', async () => {
    const f = await setup();
    const original = await prepare(f);
    await f.repo.publish(f.key, linkFile);
    await unlink(original.targetPath);
    const next = { ...f.key, publicationId: randomUUID() };
    await f.repo.register(next);
    const discard = vi.fn(removeScratch);
    await expect(f.repo.prepare(next, await file(next), discard)).rejects.toThrow(/repair.required/i);
    expect(discard).not.toHaveBeenCalled();
    expect(await ready(f.key)).toHaveLength(1);
  });

  it('T4-17 cancellation winning before publication prevents its callback and ready row', async () => {
    const f = await setup();
    const prepared = await prepare(f);
    expect((await f.repo.cancel(f.key)).status).toBe('cancelled');
    const link = vi.fn(linkFile);
    await expect(f.repo.publish(f.key, link)).rejects.toThrow('publication_aborted');
    expect(link).not.toHaveBeenCalled();
    expect(await ready(f.key)).toEqual([]);
    expect(await journal(f.key)).toMatchObject({ state: 'aborted', stagedPath: prepared.stagedPath });
  });

  it('T4-18 cancellation queued behind the final transaction reports already-published', async () => {
    const f = await setup();
    await prepare(f);
    const entered = defer(),
      finish = defer();
    // A derived handle shares the same bounded pool. Delegate the real transaction unchanged,
    // retaining its connection for observation while its publication callback is held.
    const publicationDb = db.withTables<Record<never, never>>();
    const transaction = publicationDb.transaction.bind(publicationDb);
    let publicationTx: Transaction<DB> | undefined;
    publicationDb.transaction = () => {
      const builder = transaction();
      const execute = builder.execute.bind(builder);
      builder.execute = <T>(callback: (tx: Transaction<DB>) => Promise<T>): Promise<T> =>
        execute(async (tx) => {
          publicationTx = tx;
          return callback(tx);
        });
      return builder;
    };
    const publishing = new StudioImportPublicationRepository(publicationDb).publish(f.key, async (value) => {
      entered.resolve();
      await finish.promise;
      await linkFile(value);
    });
    let cancelling: ReturnType<typeof f.repo.cancel> | undefined;
    let cancellationSettled = false;
    let outcomes: PromiseSettledResult<unknown>[];
    try {
      await waitForCallback(entered.promise, publishing);
      expect(publicationTx).toBeDefined();
      cancelling = f.repo.cancel(f.key);
      void cancelling
        .then(() => {
          cancellationSettled = true;
        })
        .catch(() => {
          cancellationSettled = true;
        });
      let waitingPid: number | undefined;
      for (let attempt = 0; attempt < 100; attempt++) {
        await sql`SELECT pg_stat_clear_snapshot()`.execute(publicationTx!);
        const { rows } = await sql<{ pid: number }>`SELECT pid FROM pg_stat_activity
          WHERE datname=current_database() AND pid<>pg_backend_pid()
            AND wait_event_type='Lock' AND pg_backend_pid()=ANY(pg_blocking_pids(pid))`.execute(publicationTx!);
        waitingPid = rows[0]?.pid;
        if (waitingPid || cancellationSettled) break;
        await new Promise((done) => setTimeout(done, 10));
      }
      expect(waitingPid, 'Cancellation must actually wait on the held publication transaction').toBeDefined();
      expect(cancellationSettled, 'Cancellation cannot settle while publication is held').toBe(false);
    } finally {
      finish.resolve();
      // Drain both real operations even when contention observation fails.
      outcomes = await Promise.allSettled([publishing, ...(cancelling ? [cancelling] : [])]);
    }
    for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason;
    expect(outcomes[1]).toMatchObject({ status: 'fulfilled', value: { status: 'already-published' } });
    expect(await ready(f.key)).toHaveLength(1);
  });

  it.each(['registered', 'preparing'] as const)(
    'T4-19 fixed expiry of %s refuses preparation/publication without extending the receipt',
    async (state) => {
      const f = await setup();
      await f.repo.register(f.key);
      if (state === 'preparing') await f.repo.prepare(f.key, await file(f.key), removeScratch);
      await expire(f.key);
      const before = await journal(f.key);
      const link = vi.fn(linkFile);
      if (state === 'registered')
        await expect(f.repo.prepare(f.key, await file(f.key), removeScratch)).rejects.toThrow(/expir/i);
      else await expect(f.repo.publish(f.key, link)).rejects.toThrow(/expir/i);
      expect(link).not.toHaveBeenCalled();
      expect(await ready(f.key)).toEqual([]);
      expect((await journal(f.key))!.expiresAt).toEqual(before!.expiresAt);
    },
  );

  it('T4-20 registration reserves no bytes; concurrent preparing reservations count once per owner', async () => {
    const f = await setup();
    await db
      .updateTable('user')
      .set({ quotaSizeInBytes: 4, quotaUsageInBytes: 0 })
      .where('id', '=', f.user.id)
      .execute();
    const otherProject = await f.projects.create({ ownerId: f.user.id, name: 'Same-owner concurrent quota' });
    const second = { ...f.key, projectId: otherProject.id, importId: randomUUID(), publicationId: randomUUID() };
    await Promise.all([f.repo.register(f.key), f.repo.register(second)]);
    const firstFile = await file(f.key);
    const secondFile = await file(second);
    const results = await Promise.allSettled([
      f.repo.prepare(f.key, firstFile, removeScratch),
      f.repo.prepare(second, secondFile, removeScratch),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const winner = results[0].status === 'fulfilled' ? f.key : second;
    await expect(f.repo.prepare(winner, await file(winner), removeScratch)).resolves.toMatchObject({
      status: 'prepared',
    });
  });

  it('T4-21 publication atomically replaces its reservation instead of double charging', async () => {
    const f = await setup();
    await db
      .updateTable('user')
      .set({ quotaSizeInBytes: 4, quotaUsageInBytes: 0 })
      .where('id', '=', f.user.id)
      .execute();
    await prepare(f);
    await expect(f.repo.publish(f.key, linkFile)).resolves.toMatchObject({ id: f.key.importId });
    expect(await f.projects.getImportBytes(f.user.id)).toBe(4);
    const second = { ...f.key, importId: randomUUID(), publicationId: randomUUID() };
    await f.repo.register(second);
    await expect(f.repo.prepare(second, await file(second), removeScratch)).rejects.toThrow(/quota/i);
  });

  it('T4-22 existing import and bundle writers cannot bypass a preparing reservation', async () => {
    const f = await setup();
    await db
      .updateTable('user')
      .set({ quotaSizeInBytes: 7, quotaUsageInBytes: 0 })
      .where('id', '=', f.user.id)
      .execute();
    const prepared = await prepare(f);
    await expect(
      f.projects.registerImport({
        ownerId: f.user.id,
        projectId: f.project.id,
        id: randomUUID(),
        path: join(root, 'legacy.mp4'),
        ...prepared.declaration,
      }),
    ).rejects.toThrow(/quota/i);
    await expect(
      f.projects.createUpload({
        ownerId: f.user.id,
        path: join(root, 'bundle.zip'),
        sizeBytes: 4,
        digest: '',
        originalFileName: 'bundle.zip',
        manifest: {},
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).rejects.toThrow(/quota/i);
  });

  it('T4-23 the existing per-project import cap also bounds new preparing reservations', async () => {
    const f = await setup();
    // Bulk fixture rows exercise admission at the real boundary; no journal transition is synthesized.
    await sql`INSERT INTO public.studio_project_import (id,"ownerId","projectId",checksum,"contentType","sizeBytes",path,"fileName")
      SELECT gen_random_uuid(),${f.user.id}::uuid,${f.project.id}::uuid,${'e'.repeat(64)},'video/mp4',4,
        ${root} || '/fixture-' || n::text,'fixture.mp4' FROM generate_series(1,${STUDIO_IMPORT_MAX_PER_PROJECT}) n`.execute(
      db,
    );
    await f.repo.register(f.key);
    await expect(f.repo.prepare(f.key, await file(f.key), removeScratch)).rejects.toThrow(/imports|limit/i);
  });

  it('T6-01 restart retries absent stage namespace barriers before compaction', async () => {
    const f = await setup(),
      prepared = await prepare(f);
    await f.repo.publish(f.key, linkFile);
    await expect(
      f.repo.release(f.key, async (file, role) => {
        await removeFile(file, role);
        throw new Error('cleanup_namespace_barrier_failed');
      }),
    ).rejects.toThrow('cleanup_namespace_barrier_failed');
    await expect(lstat(prepared.stagedPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await journal(f.key)).toMatchObject({ stagedPath: prepared.stagedPath, stagedIdentity: prepared.identity });
    const restarted = new StudioImportPublicationRepository(db),
      barriers = vi.fn(async (file: PreparedImport, role: 'stage' | 'aborted') => {
        await expect(lstat(file.stagedPath)).rejects.toMatchObject({ code: 'ENOENT' });
        await removeFile(file, role); // Modelled adapter must still acknowledge namespace barriers for absence.
      });
    await restarted.release(f.key, barriers);
    expect(barriers).toHaveBeenCalledOnce();
    expect(await journal(f.key)).toMatchObject({ state: 'published', stagedPath: null, targetPath: null });
    expect(await readFile(prepared.targetPath, 'utf8')).toBe('test');
  });

  it('T6-02 expiry remains committed when a Buddy pin defers cleanup', async () => {
    const f = await setup(),
      prepared = await prepare(f);
    await expire(f.key);
    const runId = randomUUID();
    await sql`INSERT INTO public.buddy_backup_reference ("runId",path) VALUES (${runId}::uuid,${prepared.stagedPath})`.execute(
      db,
    );
    expect(await f.repo.listRecovery()).toContainEqual(f.key);
    const remove = vi.fn(removeFile);
    await expect(f.repo.release(f.key, remove)).rejects.toThrow('publication_path_referenced');
    expect(remove).not.toHaveBeenCalled();
    expect(await journal(f.key)).toMatchObject({ state: 'aborted', stagedPath: prepared.stagedPath });
    await sql`DELETE FROM public.buddy_backup_reference WHERE "runId"=${runId}::uuid`.execute(db);
    await new StudioImportPublicationRepository(db).release(f.key, removeFile);
    expect(await journal(f.key)).toMatchObject({ state: 'aborted', stagedPath: null });
    expect(await ready(f.key)).toEqual([]);
  });

  it('T6-03 registered expiry aborts without filesystem publication or cleanup', async () => {
    const f = await setup();
    await f.repo.register(f.key);
    await expire(f.key);
    const remove = vi.fn(removeFile);
    await f.repo.release(f.key, remove);
    expect(remove).not.toHaveBeenCalled();
    expect(await journal(f.key)).toMatchObject({ state: 'aborted', stagedPath: null, targetPath: null });
    expect(await ready(f.key)).toEqual([]);
  });

  it.each(['replacement', 'symlink'] as const)('T6-04 changed stage %s retains recovery ownership', async (kind) => {
    const f = await setup(),
      prepared = await prepare(f);
    await f.repo.cancel(f.key);
    const foreign = prepared.stagedPath + '.foreign';
    ownedFiles.add(foreign);
    if (kind === 'replacement') {
      await writeFile(foreign, 'test', { flag: 'wx' });
      await rename(foreign, prepared.stagedPath);
    } else {
      await unlink(prepared.stagedPath);
      await symlink(foreign, prepared.stagedPath);
    }
    const remove = vi.fn(removeFile);
    await expect(f.repo.release(f.key, remove)).rejects.toThrow();
    expect(remove).not.toHaveBeenCalled();
    expect(await journal(f.key)).toMatchObject({
      state: 'aborted',
      stagedPath: prepared.stagedPath,
      stagedIdentity: prepared.identity,
    });
  });

  it.each(['EACCES', 'ENODEV'] as const)('T6-05 adapter %s is not acknowledged absence', async (code) => {
    const f = await setup(),
      prepared = await prepare(f);
    await f.repo.cancel(f.key);
    await expect(f.repo.release(f.key, () => Promise.reject(Object.assign(new Error(code), { code })))).rejects.toThrow(
      code,
    );
    expect(await journal(f.key)).toMatchObject({
      state: 'aborted',
      stagedPath: prepared.stagedPath,
      stagedIdentity: prepared.identity,
    });
  });

  it('T6-06 published stage pin survives project purge until exact stage cleanup, target handoff is untouched', async () => {
    const f = await setup(),
      prepared = await prepare(f);
    await f.repo.publish(f.key, linkFile);
    const runId = randomUUID();
    await sql`INSERT INTO public.buddy_backup_reference ("runId",path) VALUES (${runId}::uuid,${prepared.stagedPath})`.execute(
      db,
    );
    await expect(f.projects.delete(f.project.id)).rejects.toThrow(/cleanup is pending/i);
    await expect(f.repo.release(f.key, removeFile)).rejects.toThrow('publication_path_referenced');
    expect(await readFile(prepared.targetPath, 'utf8')).toBe('test');
    await sql`DELETE FROM public.buddy_backup_reference WHERE "runId"=${runId}::uuid`.execute(db);
    await f.repo.release(f.key, removeFile);
    await f.projects.delete(f.project.id);
    expect(await readFile(prepared.targetPath, 'utf8')).toBe('test');
    expect(await ready(f.key)).toHaveLength(1); // Orphan ready-import release is a separate existing reference-aware path.
  });

  it('T6-07 another import protects an aborted target while exact own roles alone are excluded', async () => {
    const f = await setup(),
      prepared = await prepare(f);
    await f.repo.cancel(f.key);
    await sql`INSERT INTO public.studio_project_import (id,"ownerId","projectId",checksum,"contentType","sizeBytes",path,"fileName")
      VALUES (${randomUUID()}::uuid,${f.user.id}::uuid,${f.project.id}::uuid,${prepared.declaration.checksum},'video/mp4',4,${prepared.targetPath},'other.mp4')`.execute(
      db,
    );
    const remove = vi.fn(removeFile);
    await expect(f.repo.release(f.key, remove)).rejects.toThrow('publication_path_referenced');
    expect(remove).not.toHaveBeenCalled();
    expect(await journal(f.key)).toMatchObject({ stagedPath: prepared.stagedPath, targetPath: prepared.targetPath });
  });

  it('T6-08 incoming TTL refuses journal stage and live reservation before any unlink', async () => {
    const f = await setup();
    StorageCore.setMediaLocation(root);
    const exports = join(root, 'exports'),
      owner = join(exports, f.user.id),
      imports = join(owner, 'studio-imports'),
      incoming = join(imports, 'incoming');
    for (const directory of [exports, owner, imports, incoming]) {
      await mkdir(directory, { recursive: true });
      ownedDirectories.add(directory);
    }
    const prepared = await file(f.key),
      incomingPath = join(incoming, randomUUID() + '.upload');
    await rename(prepared.stagedPath, incomingPath);
    ownedFiles.add(incomingPath);
    prepared.stagedPath = incomingPath;
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await utimes(incomingPath, old, old);
    const reservation = await f.projects.createUpload({
      ownerId: f.user.id,
      path: incomingPath,
      sizeBytes: 4,
      digest: '',
      originalFileName: '',
      manifest: {},
      expiresAt: new Date(Date.now() + 60_000),
    });
    const remove = vi.fn(async () => {
      await unlink(incomingPath);
    });
    expect(await f.repo.cleanupIncoming(f.user.id, incomingPath, new Date(), remove)).toBe(false);
    expect(remove).not.toHaveBeenCalled();
    await f.repo.register(f.key);
    await f.repo.prepare(f.key, prepared, removeScratch, reservation.id);
    await expect(f.repo.cleanupIncoming(f.user.id, incomingPath, new Date(), remove)).rejects.toThrow(
      'publication_path_referenced',
    );
    expect(remove).not.toHaveBeenCalled();
    expect(await lstat(incomingPath)).toBeDefined();
    await expire(f.key);
    await f.repo.release(f.key, removeFile);
    expect(await ready(f.key)).toEqual([]);
  });

  it('T6-09 six-hour expiry winning before an uploading prepare keeps request ownership and never publishes', async () => {
    const f = await setup(),
      scratch = await file(f.key);
    await f.repo.register(f.key);
    const reservation = await f.projects.createUpload({
      ownerId: f.user.id,
      path: scratch.stagedPath,
      sizeBytes: 4,
      digest: '',
      originalFileName: '',
      manifest: {},
      expiresAt: new Date(Date.now() + 60_000),
    });
    await expect(
      blockedOperation(
        (tx) => sql`SELECT pg_advisory_xact_lock(hashtextextended(${`buddy-studio:${f.project.id}`},0))`.execute(tx),
        () => f.repo.prepare(f.key, scratch, removeScratch, reservation.id),
        async (tx) => {
          await sql`WITH stamp AS (SELECT clock_timestamp()-interval '1 second' AS expired)
        UPDATE public.studio_import_publication SET "createdAt"=stamp.expired-interval '6 hours',"expiresAt"=stamp.expired
        FROM stamp WHERE id=${f.key.publicationId}::uuid`.execute(tx);
        },
      ),
    ).rejects.toThrow('publication_expired');
    expect(await journal(f.key)).toMatchObject({ state: 'aborted', stagedPath: null, targetPath: null });
    expect(await lstat(scratch.stagedPath)).toBeDefined();
    expect(await f.projects.getUpload(reservation.id, f.user.id)).toBeDefined();
    expect(await ready(f.key)).toEqual([]);
  });

  it('T6-10 incoming cleanup rechecks the captured version and consumes only expired request reservations', async () => {
    const f = await setup();
    StorageCore.setMediaLocation(root);
    const exports = join(root, 'exports'),
      owner = join(exports, f.user.id),
      imports = join(owner, 'studio-imports'),
      incoming = join(imports, 'incoming');
    for (const directory of [exports, owner, imports, incoming]) {
      await mkdir(directory, { recursive: true });
      ownedDirectories.add(directory);
    }
    const path = join(incoming, randomUUID() + '.upload');
    await writeFile(path, 'test', { flag: 'wx' });
    ownedFiles.add(path);
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await utimes(path, old, old);
    const reservation = await f.projects.createUpload({
      ownerId: f.user.id,
      path,
      sizeBytes: 4,
      digest: '',
      originalFileName: '',
      manifest: {},
      expiresAt: new Date(Date.now() - 60_000),
    });
    const removed = vi.fn(async (identity: string | null) => {
      const stat = await lstat(path, { bigint: true });
      expect(identity).toBe([stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':'));
      await unlink(path);
    });
    expect(await f.repo.cleanupIncoming(f.user.id, path, new Date(Date.now() - 6 * 60 * 60 * 1000), removed)).toBe(
      true,
    );
    expect(removed).toHaveBeenCalledOnce();
    expect(await f.projects.getUpload(reservation.id, f.user.id)).toBeUndefined();
    await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('T4-24 journal state owns exact path roles but never appears as readable import or declaration', async () => {
    const f = await setup();
    const prepared = await prepare(f);
    const references = (path: string) => db.transaction().execute((tx) => countPathReferences(tx, path));
    expect(await references(prepared.stagedPath)).toBe(1);
    expect(await references(prepared.targetPath)).toBe(1);
    expect(await f.projects.listImports(f.project.id)).toEqual([]);
    expect(await f.projects.listImportDeclarations(f.project.id)).toEqual([]);
    await f.repo.publish(f.key, linkFile);
    expect(await references(prepared.stagedPath)).toBe(1);
    expect(await references(prepared.targetPath)).toBe(1); // Ready row owns target; published journal owns only stage.
    await f.repo.release(f.key, removeFile);
    expect(await references(prepared.stagedPath)).toBe(0);
    expect(await references(prepared.targetPath)).toBe(1);
  });

  it.each(['published', 'aborted'] as const)(
    'T4-25 %s cleanup compacts only after acknowledged removal and barrier',
    async (state) => {
      const f = await setup();
      const prepared = await prepare(f);
      if (state === 'published') await f.repo.publish(f.key, linkFile);
      else await f.repo.cancel(f.key);
      await expect(f.repo.release(f.key, () => Promise.reject(new Error('cleanup-barrier-failed')))).rejects.toThrow(
        'cleanup-barrier-failed',
      );
      expect(await journal(f.key)).toMatchObject({
        state,
        stagedPath: prepared.stagedPath,
        targetPath: prepared.targetPath,
        stagedIdentity: prepared.identity,
      });
      await f.repo.release(f.key, async (value, role) => {
        expect(value).toEqual(prepared);
        expect(role).toBe(state === 'published' ? 'stage' : 'aborted');
        expect((await journal(f.key))!.stagedPath).toBe(prepared.stagedPath);
        await removeFile(value, role);
      });
      expect(await journal(f.key)).toMatchObject({
        state,
        stagedPath: null,
        targetPath: null,
        declaration: null,
        stagedIdentity: null,
      });
      expect((await f.repo.get(f.key))!.cleanupPending).toBe(false);
      if (state === 'published') expect(await readFile(prepared.targetPath, 'utf8')).toBe('test');
      else expect(await ready(f.key)).toEqual([]);
    },
  );

  it('T4-26 lost cleanup acknowledgement can retry compact terminal receipt without deleting ready bytes', async () => {
    const f = await setup();
    const prepared = await prepare(f);
    await f.repo.publish(f.key, linkFile);
    await expect(
      (async () => {
        await f.repo.release(f.key, removeFile);
        throw new Error('cleanup-ack-lost');
      })(),
    ).rejects.toThrow('cleanup-ack-lost');
    const remove = vi.fn(removeFile);
    await f.repo.release(f.key, remove);
    expect(remove).not.toHaveBeenCalled();
    expect(await readFile(prepared.targetPath, 'utf8')).toBe('test');
    expect((await f.repo.get(f.key))!.state).toBe('published');
  });

  it.each(['asset', 'buddy'] as const)(
    'T4-27 another %s reference prevents abort cleanup and preserves handles',
    async (reference) => {
      const f = await setup();
      const prepared = await prepare(f);
      await f.repo.cancel(f.key);
      if (reference === 'asset') await f.ctx.newAsset({ ownerId: f.user.id, originalPath: prepared.stagedPath });
      else
        await sql`INSERT INTO public.buddy_backup_reference ("runId",path) VALUES (${randomUUID()}::uuid,${prepared.targetPath})`.execute(
          db,
        );
      const remove = vi.fn(removeFile);
      await f.repo.release(f.key, remove).catch(() => {});
      expect(remove).not.toHaveBeenCalled();
      expect(await journal(f.key)).toMatchObject({ state: 'aborted', stagedPath: prepared.stagedPath });
    },
  );

  it('T4-28 a referenced target refuses publication before callback and keeps preparing evidence', async () => {
    const f = await setup();
    const prepared = await prepare(f);
    await f.ctx.newAsset({ ownerId: f.user.id, originalPath: prepared.targetPath });
    const link = vi.fn(linkFile);
    await expect(f.repo.publish(f.key, link)).rejects.toThrow();
    expect(link).not.toHaveBeenCalled();
    expect(await ready(f.key)).toEqual([]);
    expect(await journal(f.key)).toMatchObject({ state: 'preparing', stagedPath: prepared.stagedPath });
  });

  it('T4-29 publication takes the existing project advisory lock before proceeding', async () => {
    const f = await setup();
    await prepare(f);
    await blockedOperation(
      (tx) => sql`SELECT pg_advisory_xact_lock(hashtextextended(${`buddy-studio:${f.project.id}`},0))`.execute(tx),
      () => f.repo.publish(f.key, linkFile),
    );
    expect(await ready(f.key)).toHaveLength(1);
  });

  it('T4-30 project row waiting already holds the common advisory lock', async () => {
    const f = await setup();
    await f.repo.register(f.key);
    await blockedOperation(
      (tx) => tx.selectFrom('studio_project').select('id').where('id', '=', f.project.id).forUpdate().execute(),
      () => f.repo.cancel(f.key),
      (tx) => projectLockHeld(tx, f.project.id),
    );
    expect((await journal(f.key))!.state).toBe('aborted');
  });

  it('T4-31 exact journal row waiting already holds the project lock', async () => {
    const f = await setup();
    await f.repo.register(f.key);
    await blockedOperation(
      (tx) =>
        sql`SELECT id FROM public.studio_import_publication WHERE id=${f.key.publicationId}::uuid FOR UPDATE`.execute(
          tx,
        ),
      () => f.repo.cancel(f.key),
      async (tx) => {
        await projectLockHeld(tx, f.project.id);
        const { rows } = await sql<{ id: string }>`SELECT id FROM public.studio_project
          WHERE id=${f.project.id}::uuid FOR UPDATE SKIP LOCKED`.execute(tx);
        expect(rows, 'Editable project row must already be locked before waiting on the journal row').toEqual([]);
      },
    );
  });

  it('T4-32 Buddy barrier precedes owner quota locking during final publication', async () => {
    const f = await setup();
    await prepare(f);
    await blockedOperation(
      async (tx) => {
        await sql`SELECT pg_advisory_xact_lock(${BUDDY_CAPTURE_LOCK}::bigint)`.execute(tx);
        await tx.selectFrom('user').select('id').where('id', '=', f.user.id).forUpdate().execute();
      },
      () => f.repo.publish(f.key, linkFile),
      async (tx, pid) => {
        await projectLockHeld(tx, f.project.id);
        const { rows } = await sql<{
          count: number;
        }>`SELECT count(*)::int AS count FROM pg_locks WHERE pid=${pid} AND NOT granted AND locktype='advisory'`.execute(
          tx,
        );
        expect(rows[0].count).toBe(1);
      },
    );
  });

  it('T4-33 path locks use sorted order before the owner quota row', async () => {
    const f = await setup();
    const prepared = await prepare(f);
    const [first, last] = [prepared.stagedPath, prepared.targetPath].sort();
    await blockedOperation(
      (tx) => sql`SELECT pg_advisory_xact_lock(${pathKey(last)}::bigint)`.execute(tx),
      () => f.repo.publish(f.key, linkFile),
      async (tx) => {
        const { rows } = await sql<{
          available: boolean;
        }>`SELECT pg_try_advisory_xact_lock(${pathKey(first)}::bigint) AS available`.execute(tx);
        expect(rows[0].available).toBe(false);
        await tx.selectFrom('user').select('id').where('id', '=', f.user.id).forUpdate().noWait().execute();
      },
    );
  });

  it('T4-34 owner quota waiting retains project and both path locks', async () => {
    const f = await setup();
    const prepared = await prepare(f);
    await blockedOperation(
      (tx) => tx.selectFrom('user').select('id').where('id', '=', f.user.id).forUpdate().execute(),
      () => f.repo.publish(f.key, linkFile),
      async (tx) => {
        await projectLockHeld(tx, f.project.id);
        for (const path of [prepared.stagedPath, prepared.targetPath]) {
          const { rows } = await sql<{
            available: boolean;
          }>`SELECT pg_try_advisory_xact_lock(${pathKey(path)}::bigint) AS available`.execute(tx);
          expect(rows[0].available).toBe(false);
        }
      },
    );
  });

  it('T7-01 exact owner/project publication lookup reuses the immutable import binding', async () => {
    const f = await setup(),
      other = await setup();
    await f.repo.register(f.key);
    expect(await f.repo.getByPublication(f.user.id, f.project.id, f.key.publicationId)).toMatchObject({
      publicationId: f.key.publicationId,
      importId: f.key.importId,
      state: 'registered',
    });
    expect(await f.repo.getByPublication(other.user.id, f.project.id, f.key.publicationId)).toBeNull();
    expect(await f.repo.getByPublication(f.user.id, other.project.id, f.key.publicationId)).toBeNull();
    await expect(f.repo.getByPublication(f.user.id, f.project.id, 'invalid')).rejects.toThrow();
  });

  it('T4-35 discovery pages over 100 equal-timestamp receipts without duplicates or private file fields', async () => {
    const f = await setup();
    const keys = Array.from({ length: 105 }, () => ({ ...f.key, publicationId: randomUUID() }));
    for (const key of keys) await f.repo.register(key);
    const at = new Date('2026-10-11T00:00:00Z');
    await sql`UPDATE public.studio_import_publication SET "createdAt"=${at},"expiresAt"=${new Date(at.getTime() + 6 * 60 * 60 * 1000)} WHERE "projectId"=${f.project.id}::uuid`.execute(
      db,
    );
    const one = await f.repo.discover(f.user.id, f.project.id);
    expect(one.items).toHaveLength(100);
    expect(one.nextCursor).not.toBeNull();
    const two = await f.repo.discover(f.user.id, f.project.id, one.nextCursor!);
    expect(two.items).toHaveLength(5);
    expect(two.nextCursor).toBeNull();
    const all = [...one.items, ...two.items];
    expect(new Set(all.map((item) => item.publicationId)).size).toBe(105);
    expect(all.map((item) => item.publicationId)).toEqual(keys.map((key) => key.publicationId).sort());
    for (const item of all)
      expect(Object.keys(item).sort()).toEqual(
        ['cleanupPending', 'createdAt', 'expiresAt', 'importId', 'publicationId', 'state'].sort(),
      );
    await f.repo.cancel(keys[0]);
    expect(
      (await f.repo.discover(f.user.id, f.project.id, undefined, 'aborted')).items.map((r) => r.publicationId),
    ).toEqual([keys[0].publicationId]);
  });

  it('T4-36 strict cursor/state validation and owner-scoped cursors never disclose another project', async () => {
    const f = await setup(),
      other = await setup();
    await f.repo.register(f.key);
    await expect(f.repo.discover(f.user.id, f.project.id, 'not-a-valid-cursor')).rejects.toThrow();
    await expect(f.repo.discover(f.user.id, f.project.id, undefined, 'unknown' as never)).rejects.toThrow();
    const keys = Array.from({ length: 101 }, () => ({ ...f.key, publicationId: randomUUID() }));
    for (const key of keys) await f.repo.register(key);
    const cursor = (await f.repo.discover(f.user.id, f.project.id)).nextCursor!;
    await expect(f.repo.discover(other.user.id, f.project.id, cursor)).rejects.toThrow();
    expect((await f.repo.discover(other.user.id, other.project.id)).items).toEqual([]);
  });

  it.each(['delete', 'sweep', 'account'] as const)(
    'T4-37 %s purge cannot erase pending handles, and cleanup does not restore edit authority',
    async (kind) => {
      const f = await setup();
      const prepared = await prepare(f);
      await f.repo.cancel(f.key);
      if (kind === 'sweep') await f.projects.trash(f.project.id, new Date(Date.now() - 1000));
      // Either deferring deletion or retaining an orphan journal is safe; losing full handles is never safe.
      const deletion =
        kind === 'delete'
          ? f.projects.delete(f.project.id)
          : kind === 'sweep'
            ? f.projects.deletePurgeable(new Date())
            : f.ctx.get(UserRepository).delete({ id: f.user.id }, true);
      await deletion.catch(() => {});
      expect(await journal(f.key)).toMatchObject({
        state: 'aborted',
        ownerId: f.user.id,
        projectId: f.project.id,
        stagedPath: prepared.stagedPath,
        targetPath: prepared.targetPath,
        stagedIdentity: prepared.identity,
      });
      await expect(f.repo.prepare(f.key, await file(f.key), removeScratch)).rejects.toThrow('publication_aborted');
      await f.repo.release(f.key, removeFile);
      expect(await journal(f.key)).toMatchObject({ state: 'aborted', stagedPath: null, targetPath: null });
    },
  );
  it.each(['matching', 'conflicting'] as const)(
    'T4-38 an actual ready row dominates an older preparing journal only when %s',
    async (kind) => {
      const f = await setup();
      const prepared = await prepare(f);
      await linkFile(prepared);
      // Seed a real preexisting ready row, as from another committed writer; never fake journal publication.
      await sql`INSERT INTO public.studio_project_import
      (id,"ownerId","projectId",checksum,"contentType","sizeBytes",path,"fileName","processingProvenance")
      VALUES (${f.key.importId}::uuid,${f.user.id}::uuid,${f.project.id}::uuid,
        ${kind === 'matching' ? prepared.declaration.checksum : 'f'.repeat(64)},
        ${prepared.declaration.contentType},${prepared.declaration.sizeBytes},${prepared.targetPath},
        ${prepared.declaration.fileName},${JSON.stringify(prepared.declaration.processingProvenance)}::text::jsonb)`.execute(
        db,
      );
      const before = await ready(f.key),
        link = vi.fn(linkFile);
      if (kind === 'matching') {
        await expect(f.repo.publish(f.key, link)).resolves.toMatchObject({ id: f.key.importId });
        expect((await journal(f.key))!.state).toBe('published');
      } else {
        await expect(f.repo.publish(f.key, link)).rejects.toThrow();
        expect(await journal(f.key)).toMatchObject({ state: 'preparing', stagedPath: prepared.stagedPath });
      }
      expect(link).not.toHaveBeenCalled();
      expect(await ready(f.key)).toEqual(before);
    },
  );

  it('T4-39 expiry committed while publication waits for the project lock wins before its callback', async () => {
    const f = await setup();
    await prepare(f);
    const link = vi.fn(linkFile);
    await expect(
      blockedOperation(
        (tx) => sql`SELECT pg_advisory_xact_lock(hashtextextended(${`buddy-studio:${f.project.id}`},0))`.execute(tx),
        () => f.repo.publish(f.key, link),
        async (tx) => {
          await sql`WITH stamp AS (SELECT clock_timestamp()-interval '1 second' AS expired)
          UPDATE public.studio_import_publication SET "createdAt"=stamp.expired-interval '6 hours',
          "expiresAt"=stamp.expired FROM stamp WHERE id=${f.key.publicationId}::uuid`.execute(tx);
        },
      ),
    ).rejects.toThrow(/expir/i);
    expect(link).not.toHaveBeenCalled();
    expect(await ready(f.key)).toEqual([]);
  });

  it('T4-40 racing a global publication ID across two valid owner projects retains exactly one binding', async () => {
    const f = await setup(),
      other = await setup();
    const second = { ...other.key, publicationId: f.key.publicationId };
    const attempts = await Promise.allSettled([f.repo.register(f.key), other.repo.register(second)]);
    expect(attempts.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const winner = attempts[0].status === 'fulfilled' ? f.key : second;
    expect(await journal(winner)).toMatchObject({
      ownerId: winner.ownerId,
      projectId: winner.projectId,
      importId: winner.importId,
    });
  });

  it('T4-41 release uses the common project lock and preserves terminal receipt identity', async () => {
    const f = await setup();
    await prepare(f);
    await f.repo.cancel(f.key);
    await blockedOperation(
      (tx) => sql`SELECT pg_advisory_xact_lock(hashtextextended(${`buddy-studio:${f.project.id}`},0))`.execute(tx),
      () => f.repo.release(f.key, removeFile),
    );
    expect(await journal(f.key)).toMatchObject({ id: f.key.publicationId, state: 'aborted', stagedPath: null });
  });

  it('T4-42 cancelling a different attempt never cancels an existing retained import', async () => {
    const f = await setup();
    await prepare(f);
    await f.repo.publish(f.key, linkFile);
    const second = { ...f.key, publicationId: randomUUID() };
    await f.repo.register(second);
    expect((await f.repo.cancel(second)).status).toBe('cancelled');
    expect((await journal(f.key))!.state).toBe('published');
    expect(await ready(f.key)).toHaveLength(1);
  });

  it('T4-43 published get/discovery expose retained identity without operational paths or inode facts', async () => {
    const f = await setup();
    const prepared = await prepare(f);
    await f.repo.publish(f.key, linkFile);
    const exact = await f.repo.get(f.key);
    const discovered = (await f.repo.discover(f.user.id, f.project.id)).items[0];
    for (const receipt of [exact, discovered]) {
      expect(receipt).toMatchObject({ state: 'published', imported: { id: f.key.importId } });
      expect(JSON.stringify(receipt)).not.toContain(prepared.stagedPath);
      expect(JSON.stringify(receipt)).not.toContain(prepared.targetPath);
      expect(receipt).not.toHaveProperty('stagedIdentity');
      expect(receipt).not.toHaveProperty('declaration');
    }
  });

  it('T4-44 a same-hash foreign target inode is not adopted after exclusive linking refuses', async () => {
    const f = await setup();
    const prepared = await prepare(f);
    await writeFile(prepared.targetPath, 'test', { flag: 'wx', mode: 0o600 });
    const foreign = await lstat(prepared.targetPath, { bigint: true });
    expect(String(foreign.ino)).not.toBe(prepared.identity.ino);
    await expect(f.repo.publish(f.key, linkFile)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await ready(f.key)).toEqual([]);
    expect(await journal(f.key)).toMatchObject({ state: 'preparing', stagedPath: prepared.stagedPath });
    expect(String((await lstat(prepared.targetPath, { bigint: true })).ino)).toBe(String(foreign.ino));
    expect(await readFile(prepared.targetPath, 'utf8')).toBe('test');
  });

  it('T4-45 duplicate scratch with another reference is never discarded or substituted for original handles', async () => {
    const f = await setup();
    const original = await prepare(f),
      duplicate = await file(f.key);
    await f.ctx.newAsset({ ownerId: f.user.id, originalPath: duplicate.stagedPath });
    const discard = vi.fn(removeScratch);
    await f.repo.prepare(f.key, duplicate, discard).catch(() => {});
    expect(discard).not.toHaveBeenCalled();
    expect(await lstat(duplicate.stagedPath)).toBeDefined();
    expect(await journal(f.key)).toMatchObject({
      state: 'preparing',
      stagedPath: original.stagedPath,
      stagedIdentity: original.identity,
    });
  });

  it('T4-46 a retry presenting the original prepared handle cannot discard that owned stage', async () => {
    const f = await setup();
    const original = await prepare(f),
      discard = vi.fn(removeScratch);
    await expect(f.repo.prepare(f.key, original, discard)).resolves.toEqual({ status: 'prepared', file: original });
    expect(discard).not.toHaveBeenCalled();
    expect(await lstat(original.stagedPath)).toBeDefined();
  });
});

// Supplemental coverage for the participating account-delete guard; accepted T4-01..46 stay unchanged.
describe('Studio import publication — participating callers and precise keysets', () => {
  it('A4-01 hard account deletion waits for published stage cleanup and succeeds after release', async () => {
    const f = await setup();
    const prepared = await prepare(f);
    await f.repo.publish(f.key, linkFile);
    const users = f.ctx.get(UserRepository);
    await expect(users.delete({ id: f.user.id }, true)).rejects.toThrow(/cleanup is pending/i);
    expect(await db.selectFrom('user').select('id').where('id', '=', f.user.id).executeTakeFirst()).toBeDefined();
    expect(await journal(f.key)).toMatchObject({ state: 'published', stagedPath: prepared.stagedPath });
    await f.repo.release(f.key, removeFile);
    await users.delete({ id: f.user.id }, true);
    expect(await db.selectFrom('user').select('id').where('id', '=', f.user.id).executeTakeFirst()).toBeUndefined();
    expect(await journal(f.key)).toBeUndefined();
    // Account deletion never compensates by deleting the ready target; orphan cleanup owns that work.
    expect(await readFile(prepared.targetPath, 'utf8')).toBe('test');
  });

  it('A4-02 a project committed while hard deletion waits forces retry without deleting the account', async () => {
    const f = await setup();
    let createdId: string | undefined;
    await expect(
      blockedOperation(
        (tx) => tx.selectFrom('studio_project').select('id').where('id', '=', f.project.id).forUpdate().execute(),
        () => f.ctx.get(UserRepository).delete({ id: f.user.id }, true),
        async (tx) => {
          // An actual lock wait proves deletion already scanned and selected the original project.
          const created = await tx
            .insertInto('studio_project')
            .values({ ownerId: f.user.id, name: 'Concurrent project' })
            .returning('id')
            .executeTakeFirstOrThrow();
          createdId = created.id;
        },
      ),
    ).rejects.toThrow('Studio projects changed');
    expect(createdId).toBeDefined();
    expect(await db.selectFrom('user').select('id').where('id', '=', f.user.id).executeTakeFirst()).toBeDefined();
    expect(
      await db.selectFrom('studio_project').select('id').where('id', '=', createdId!).executeTakeFirst(),
    ).toBeDefined();
  });

  it('A4-03 soft account deletion remains available and retains full pending cleanup handles', async () => {
    const f = await setup();
    const prepared = await prepare(f);
    await f.ctx.get(UserRepository).delete({ id: f.user.id });
    const owner = await db.selectFrom('user').select('deletedAt').where('id', '=', f.user.id).executeTakeFirstOrThrow();
    expect(owner.deletedAt).not.toBeNull();
    expect(await journal(f.key)).toMatchObject({
      state: 'preparing',
      stagedPath: prepared.stagedPath,
      targetPath: prepared.targetPath,
      stagedIdentity: prepared.identity,
    });
    const link = vi.fn(linkFile);
    await expect(f.repo.publish(f.key, link)).rejects.toThrow();
    expect(link).not.toHaveBeenCalled();
  });

  it('A4-04 discovery keeps PostgreSQL microsecond precision across a page boundary', async () => {
    const f = await setup();
    const keys = Array.from({ length: 105 }, () => ({ ...f.key, publicationId: randomUUID() }));
    for (const key of keys) await f.repo.register(key);
    await sql`WITH ordered AS (
      SELECT id,row_number() OVER (ORDER BY id)-1 AS n FROM public.studio_import_publication
      WHERE "projectId"=${f.project.id}::uuid
    ), stamp AS (
      SELECT id,timestamptz '2026-10-11T00:00:00Z'+n*interval '1 microsecond' AS at FROM ordered
    ) UPDATE public.studio_import_publication journal SET "createdAt"=stamp.at,"expiresAt"=stamp.at+interval '6 hours'
      FROM stamp WHERE journal.id=stamp.id`.execute(db);
    const first = await f.repo.discover(f.user.id, f.project.id);
    expect(first.items).toHaveLength(100);
    expect(first.nextCursor).not.toBeNull();
    const second = await f.repo.discover(f.user.id, f.project.id, first.nextCursor!);
    expect(second.items).toHaveLength(5);
    expect(second.nextCursor).toBeNull();
    const all = [...first.items, ...second.items].map((row) => row.publicationId);
    expect(all).toEqual(keys.map((key) => key.publicationId).sort());
    expect(new Set(all).size).toBe(105);
  });

  it('A4-05 an administrator restoring their own project takes paths before the aliased quota row', async () => {
    const f = await setup();
    await db.updateTable('user').set({ isAdmin: true }).where('id', '=', f.user.id).execute();
    const { session } = await f.ctx.newSession({ userId: f.user.id, pinExpiresAt: new Date(Date.now() + 300_000) });
    const token = randomUUID();
    const operation = await db
      .insertInto('media_operation')
      .values({
        ownerId: f.user.id,
        kind: MediaOperationKind.BuddyRestore,
        destination: MediaOperationDestination.Local,
        label: 'Owned restore lock acceptance',
        snapshot: {},
        settings: {},
        status: MediaOperationStatus.Rendering,
        claimToken: token,
        claimExpiresAt: new Date(Date.now() + 300_000),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const path = join(root, 'alias-lock-' + randomUUID());
    await blockedOperation(
      (tx) => lockFilePath(tx, path),
      () =>
        new BuddyBackupStudioRepository(db).guarded(
          {
            project: {
              version: 1,
              id: f.project.id,
              ownerId: f.user.id,
              name: f.project.name,
              currentRevision: 0,
              createdAt: new Date().toISOString(),
              archivedAt: null,
              thumbnailAssetId: null,
              duplicatedFromId: null,
              importedFromDigest: null,
              revisions: [],
              comments: [],
              imports: [],
              generated: [],
              exports: [],
              files: [],
            },
            actorId: f.user.id,
            sessionId: session.id,
            operationId: operation.id,
            claimToken: token,
            authorize: async () => {},
          },
          async (tx) => {
            await lockFilePath(tx, path);
            await assertStudioStorageAdmission(tx, f.user.id, 0);
          },
        ),
      async (tx) => {
        await projectLockHeld(tx, f.project.id);
        // Causal path contention is already established. Taking quota NOWAIT here must
        // succeed: an early actor FOR SHARE would create path->owner->path deadlock.
        await tx
          .selectFrom('user')
          .select('id')
          .where('id', '=', f.user.id)
          .forUpdate()
          .noWait()
          .executeTakeFirstOrThrow();
      },
    );
  });

  it('A4-06 a revision save blocked by publication waits on project authority before owner quota', async () => {
    const f = await setup();
    await f.projects.acquireLease(f.project.id, {
      userId: f.user.id,
      clientId: 'revision-tab',
      leaseMs: 60_000,
      takeover: false,
    });
    await prepare(f);
    const entered = defer(),
      finish = defer();
    // Retain the real publication transaction for observation through its existing
    // connection; this derived handle adds no tables or pool connections.
    const publicationDb = db.withTables<Record<never, never>>();
    const transaction = publicationDb.transaction.bind(publicationDb);
    let publicationTx: Transaction<DB> | undefined;
    publicationDb.transaction = () => {
      const builder = transaction();
      const execute = builder.execute.bind(builder);
      builder.execute = <T>(callback: (tx: Transaction<DB>) => Promise<T>): Promise<T> =>
        execute(async (tx) => {
          publicationTx = tx;
          return callback(tx);
        });
      return builder;
    };
    const publishing = new StudioImportPublicationRepository(publicationDb).publish(f.key, async (value) => {
      entered.resolve();
      await finish.promise;
      await linkFile(value);
    });
    let saving: ReturnType<typeof f.projects.appendRevision> | undefined;
    let saveSettled = false;
    let outcomes: PromiseSettledResult<unknown>[];
    try {
      await waitForCallback(entered.promise, publishing);
      expect(publicationTx).toBeDefined();
      saving = f.projects.appendRevision({
        projectId: f.project.id,
        expectedRevision: 0,
        authorId: f.user.id,
        leaseClientId: 'revision-tab',
        leaseMs: 60_000,
        envelope: { schemaVersion: 1, engine: 'freecut', engineRevision: 'r', graph: { tracks: [] } },
        digest: 'revision-lock-order',
        graphBytes: 12,
        summary: { counts: {}, total: 0 },
        requestKey: 'revision-lock-order',
        restoredFromRevision: null,
      });
      void saving
        .then(() => {
          saveSettled = true;
        })
        .catch(() => {
          saveSettled = true;
        });
      let waiting: { pid: number; query: string } | undefined;
      for (let attempt = 0; attempt < 100; attempt++) {
        await sql`SELECT pg_stat_clear_snapshot()`.execute(publicationTx!);
        const { rows } = await sql<{ pid: number; query: string }>`SELECT pid,query FROM pg_stat_activity
          WHERE datname=current_database() AND pid<>pg_backend_pid()
            AND wait_event_type='Lock' AND pg_backend_pid()=ANY(pg_blocking_pids(pid))`.execute(publicationTx!);
        waiting = rows[0];
        if (waiting || saveSettled) break;
        await new Promise((done) => setTimeout(done, 10));
      }
      expect(waiting, 'Revision must actually wait on the held journal publication transaction').toBeDefined();
      expect(saveSettled, 'Revision cannot settle while publication retains project authority').toBe(false);
      // The old owner-first path instead waits in its user FOR UPDATE query. Assert
      // the actual first contended query and lock type, without creating a deadlock
      // or treating an elapsed delay/automatic retry as evidence of correct ordering.
      expect(waiting!.query).toMatch(/pg_advisory_xact_lock.*hashtextextended/s);
      const { rows: locks } = await sql<{ count: number }>`SELECT count(*)::int AS count FROM pg_locks
        WHERE pid=${waiting!.pid} AND locktype='advisory' AND NOT granted`.execute(publicationTx!);
      expect(locks[0].count).toBe(1);
    } finally {
      finish.resolve();
      outcomes = await Promise.allSettled([publishing, ...(saving ? [saving] : [])]);
    }
    for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason;
    expect(outcomes[1]).toMatchObject({
      status: 'fulfilled',
      value: { status: 'appended', revision: { revision: 1 } },
    });
    expect(await ready(f.key)).toHaveLength(1);
    expect((await f.projects.getById(f.project.id))?.currentRevision).toBe(1);
    expect((await f.projects.getRevision(f.project.id, 1))?.digest).toBe('revision-lock-order');
  });
  it('A4-07 duplication waits on its existing source project before owner quota and FK admission', async () => {
    const f = await setup();
    await prepare(f);
    const entered = defer(),
      finish = defer();
    // Retain the real publication transaction for observation through its existing
    // connection; this derived handle adds no tables or pool connections.
    const publicationDb = db.withTables<Record<never, never>>();
    const transaction = publicationDb.transaction.bind(publicationDb);
    let publicationTx: Transaction<DB> | undefined;
    publicationDb.transaction = () => {
      const builder = transaction();
      const execute = builder.execute.bind(builder);
      builder.execute = <T>(callback: (tx: Transaction<DB>) => Promise<T>): Promise<T> =>
        execute(async (tx) => {
          publicationTx = tx;
          return callback(tx);
        });
      return builder;
    };
    const publishing = new StudioImportPublicationRepository(publicationDb).publish(f.key, async (value) => {
      entered.resolve();
      await finish.promise;
      await linkFile(value);
    });
    let saving: ReturnType<typeof f.projects.createWithRevision> | undefined;
    let saveSettled = false;
    let outcomes: PromiseSettledResult<unknown>[];
    try {
      await waitForCallback(entered.promise, publishing);
      expect(publicationTx).toBeDefined();
      saving = f.projects.createWithRevision({
        ownerId: f.user.id,
        name: 'Concurrent duplicate',
        duplicatedFromId: f.project.id,
        creation: { requestKey: 'duplicate-lock-order', digest: 'duplicate-lock-order' },
        revision: {
          authorId: f.user.id,
          envelope: { schemaVersion: 1, engine: 'freecut', engineRevision: 'r', graph: { tracks: [] } },
          digest: 'duplicate-lock-order',
          graphBytes: 12,
          summary: { counts: {}, total: 0 },
          requestKey: 'initial',
        },
      });
      void saving
        .then(() => {
          saveSettled = true;
        })
        .catch(() => {
          saveSettled = true;
        });
      let waiting: { pid: number; query: string } | undefined;
      for (let attempt = 0; attempt < 100; attempt++) {
        await sql`SELECT pg_stat_clear_snapshot()`.execute(publicationTx!);
        const { rows } = await sql<{ pid: number; query: string }>`SELECT pid,query FROM pg_stat_activity
          WHERE datname=current_database() AND pid<>pg_backend_pid()
            AND wait_event_type='Lock' AND pg_backend_pid()=ANY(pg_blocking_pids(pid))`.execute(publicationTx!);
        waiting = rows[0];
        if (waiting || saveSettled) break;
        await new Promise((done) => setTimeout(done, 10));
      }
      expect(waiting, 'Duplication must actually wait on the held journal publication transaction').toBeDefined();
      expect(saveSettled, 'Duplication cannot settle while publication retains project authority').toBe(false);
      // The old owner-first path instead waits in its user FOR UPDATE query. Assert
      // the actual first contended query and lock type, without creating a deadlock
      // or treating an elapsed delay/automatic retry as evidence of correct ordering.
      expect(waiting!.query).toMatch(/pg_advisory_xact_lock.*hashtextextended/s);
      const { rows: locks } = await sql<{ count: number }>`SELECT count(*)::int AS count FROM pg_locks
        WHERE pid=${waiting!.pid} AND locktype='advisory' AND NOT granted`.execute(publicationTx!);
      expect(locks[0].count).toBe(1);
    } finally {
      finish.resolve();
      outcomes = await Promise.allSettled([publishing, ...(saving ? [saving] : [])]);
    }
    for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason;
    expect(outcomes[1]).toMatchObject({
      status: 'fulfilled',
      value: { created: true, project: { duplicatedFromId: f.project.id, currentRevision: 1 } },
    });
    expect(await ready(f.key)).toHaveLength(1);
    const created = await f.projects.getByCreateRequestKey(f.user.id, 'duplicate-lock-order');
    expect(created?.duplicatedFromId).toBe(f.project.id);
    expect((await f.projects.getRevision(created!.id, 1))?.digest).toBe('duplicate-lock-order');
    expect((await f.projects.getById(f.project.id))?.currentRevision).toBe(0);
  });
});
