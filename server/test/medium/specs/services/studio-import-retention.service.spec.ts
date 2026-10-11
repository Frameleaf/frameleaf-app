import { Kysely, sql } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdtemp, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { StudioImportPublicationRepository } from 'src/repositories/studio-import-publication.repository.js';
import { StudioProjectRepository } from 'src/repositories/studio-project.repository.js';
import type { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { retainImport } from 'src/services/studio-import-publication.service.js';
import type { FilePort, JournalPort, PreparedImport, PublicationKey } from 'src/utils/studio-import-publication.js';
import { DECLARATION } from 'test/fixtures/studio-import-retention.js';
import { newMediumService } from 'test/medium.factory.js';
import { getLibraryQueueDB as createRetentionTestDatabase } from 'test/medium/library-queue-database.js';

// Real disposable SQL and temporary bytes, with explicitly modelled FilePort barriers.
// These cases exercise orchestration/transaction boundaries; they cannot qualify storage durability.
let db: Kysely<DB>;
let root: string;
const paths = new Set<string>();
beforeAll(async () => {
  db = await createRetentionTestDatabase();
  root = await mkdtemp(join(tmpdir(), 'fl111-retain-'));
});
afterAll(async () => {
  try {
    for (const path of paths)
      await unlink(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    if (root) await rmdir(root);
  } finally {
    await db?.destroy();
  }
});
const setup = async () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const { user } = await ctx.newUser();
  const project = await ctx.get(StudioProjectRepository).create({ ownerId: user.id, name: 'Retention orchestration' });
  const key = { ownerId: user.id, projectId: project.id, importId: randomUUID(), publicationId: randomUUID() };
  const journal = new StudioImportPublicationRepository(db);
  await journal.register(key);
  return { key, journal };
};
const scratch = async (key: PublicationKey): Promise<PreparedImport> => {
  const stagedPath = join(root, `${randomUUID()}.upload`);
  const targetPath = join(root, `${key.projectId}-${key.importId}.mp4`);
  await writeFile(stagedPath, 'test', { flag: 'wx', mode: 0o600 });
  paths.add(stagedPath);
  paths.add(targetPath);
  const stat = await lstat(stagedPath, { bigint: true });
  const checksum = createHash('sha256').update('test').digest('hex');
  return {
    stagedPath,
    targetPath,
    identity: { dev: String(stat.dev), ino: String(stat.ino), size: Number(stat.size) },
    declaration: {
      ...DECLARATION,
      checksum,
      processingProvenance: { ...DECLARATION.processingProvenance, outputSha256: checksum },
    },
  };
};
const filePort = (file: PreparedImport, events: string[], failure?: 'target' | 'cleanup'): FilePort => ({
  prepare: async () => {
    events.push('model-stage/file/ancestor-barriers');
    return file;
  },
  publish: async () => {
    events.push('link');
    await link(file.stagedPath, file.targetPath);
    if (failure === 'target') throw new Error('model_target_barrier_failed');
    events.push('model-target-barriers');
  },
  release: async (owned, role) => {
    if (failure === 'cleanup') throw new Error('model_cleanup_barrier_failed');
    for (const path of role === 'stage' ? [owned.stagedPath] : [owned.targetPath, owned.stagedPath])
      await unlink(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    events.push('model-stage-unlink/barriers');
  },
});
const traceJournal = (journal: JournalPort, events: string[]): JournalPort => ({
  register: (key) => journal.register(key),
  get: (key) => journal.get(key),
  discover: (...args) => journal.discover(...args),
  cancel: (key) => journal.cancel(key),
  prepare: async (...args) => {
    const state = await journal.prepare(...args);
    events.push('prepare-commit-ack');
    return state;
  },
  publish: async (...args) => {
    const imported = await journal.publish(...args);
    events.push('final-commit-ack');
    return imported;
  },
  release: (...args) => journal.release(...args),
});
const rows = async (key: PublicationKey) =>
  (
    await sql`SELECT * FROM public.studio_project_import
  WHERE "projectId"=${key.projectId}::uuid AND id=${key.importId}::uuid`.execute(db)
  ).rows;

describe('retention orchestration with real journal SQL and modelled storage barriers', () => {
  it('acknowledges preparing before linking and final ready/published state before cleanup', async () => {
    const { key, journal } = await setup();
    const file = await scratch(key),
      events: string[] = [];
    const imported = await retainImport(traceJournal(journal, events), filePort(file, events), {
      key,
      incoming: file.stagedPath,
      declaration: file.declaration,
    });
    expect(imported.path).toBe(file.targetPath);
    expect(await readFile(imported.path, 'utf8')).toBe('test');
    expect(await rows(key)).toHaveLength(1);
    expect(await journal.get(key)).toMatchObject({ state: 'published', cleanupPending: false });
    expect(events).toEqual([
      'model-stage/file/ancestor-barriers',
      'prepare-commit-ack',
      'link',
      'model-target-barriers',
      'final-commit-ack',
      'model-stage-unlink/barriers',
    ]);
  });
  it('preserves preparing ownership and inserts no ready row after a failed target barrier', async () => {
    const { key, journal } = await setup();
    const file = await scratch(key),
      events: string[] = [];
    await expect(
      retainImport(journal, filePort(file, events, 'target'), {
        key,
        incoming: file.stagedPath,
        declaration: file.declaration,
      }),
    ).rejects.toThrow('model_target_barrier_failed');
    expect(await rows(key)).toHaveLength(0);
    expect(await journal.get(key)).toMatchObject({ state: 'preparing', cleanupPending: true });
    expect(await readFile(file.stagedPath, 'utf8')).toBe('test');
    expect(events).not.toContain('model-stage-unlink/barriers');
  });
  it('returns a committed result with cleanupPending after a cleanup failure', async () => {
    const { key, journal } = await setup();
    const file = await scratch(key),
      events: string[] = [];
    await retainImport(journal, filePort(file, events, 'cleanup'), {
      key,
      incoming: file.stagedPath,
      declaration: file.declaration,
    });
    expect(await rows(key)).toHaveLength(1);
    expect(await journal.get(key)).toMatchObject({ state: 'published', cleanupPending: true });
    expect(await readFile(file.stagedPath, 'utf8')).toBe('test');
  });
  it('preserves a committed prepare whose acknowledgement is lost and never calls link', async () => {
    const { key, journal } = await setup();
    const file = await scratch(key),
      events: string[] = [];
    const lost = traceJournal(journal, events);
    lost.prepare = async (...args) => {
      await journal.prepare(...args);
      throw new Error('commit_unknown');
    };
    await expect(
      retainImport(lost, filePort(file, events), { key, incoming: file.stagedPath, declaration: file.declaration }),
    ).rejects.toThrow('commit_unknown');
    expect(await journal.get(key)).toMatchObject({ state: 'preparing', cleanupPending: true });
    expect(await rows(key)).toHaveLength(0);
    expect(events).toEqual(['model-stage/file/ancestor-barriers']);
    expect(await readFile(file.stagedPath, 'utf8')).toBe('test');
  });
  it('keeps the committed import and stage after a lost final acknowledgement; cancellation reports already-published', async () => {
    const { key, journal } = await setup();
    const file = await scratch(key),
      events: string[] = [];
    const lost = traceJournal(journal, events);
    lost.publish = async (...args) => {
      await journal.publish(...args);
      throw new Error('commit_unknown');
    };
    await expect(
      retainImport(lost, filePort(file, events), { key, incoming: file.stagedPath, declaration: file.declaration }),
    ).rejects.toThrow('commit_unknown');
    expect(await rows(key)).toHaveLength(1);
    expect(await journal.get(key)).toMatchObject({ state: 'published', cleanupPending: true });
    expect(await journal.cancel(key)).toMatchObject({ status: 'already-published' });
    expect(await readFile(file.stagedPath, 'utf8')).toBe('test');
    expect(await readFile(file.targetPath, 'utf8')).toBe('test');
    expect(events).not.toContain('model-stage-unlink/barriers');
  });
  it('refuses a foreign target inode with identical bytes without adopting or removing it', async () => {
    const { key, journal } = await setup();
    const file = await scratch(key),
      events: string[] = [];
    await writeFile(file.targetPath, 'test', { flag: 'wx' });
    await expect(
      retainImport(journal, filePort(file, events), { key, incoming: file.stagedPath, declaration: file.declaration }),
    ).rejects.toThrow('publication_target_exists');
    expect(await rows(key)).toHaveLength(0);
    expect(await readFile(file.targetPath, 'utf8')).toBe('test');
    expect(events).not.toContain('link');
  });
  it('answers a second publication from the ready import and refuses missing original target repair', async () => {
    const { key, journal } = await setup();
    const first = await scratch(key),
      events: string[] = [];
    await retainImport(journal, filePort(first, events), {
      key,
      incoming: first.stagedPath,
      declaration: first.declaration,
    });
    const retryKey = { ...key, publicationId: randomUUID() };
    await journal.register(retryKey);
    const retry = await scratch(retryKey),
      retryEvents: string[] = [];
    await retainImport(journal, filePort(retry, retryEvents), {
      key: retryKey,
      incoming: retry.stagedPath,
      declaration: retry.declaration,
    });
    expect(await journal.get(retryKey)).toMatchObject({ state: 'published' });
    expect(retryEvents).not.toContain('link');
    await unlink(first.targetPath);
    const missingKey = { ...key, publicationId: randomUUID() };
    await journal.register(missingKey);
    const missing = await scratch(missingKey);
    await expect(
      retainImport(journal, filePort(missing, []), {
        key: missingKey,
        incoming: missing.stagedPath,
        declaration: missing.declaration,
      }),
    ).rejects.toThrow('studio_import_repair_required');
    expect(await readFile(missing.stagedPath, 'utf8')).toBe('test');
  });
  it('does not publish when cancellation wins before the final lock', async () => {
    const { key, journal } = await setup();
    const file = await scratch(key),
      events: string[] = [];
    const cancelled = traceJournal(journal, events);
    cancelled.publish = async (...args) => {
      await journal.cancel(key);
      return journal.publish(...args);
    };
    await expect(
      retainImport(cancelled, filePort(file, events), {
        key,
        incoming: file.stagedPath,
        declaration: file.declaration,
      }),
    ).rejects.toThrow('publication_aborted');
    expect(await rows(key)).toHaveLength(0);
    expect(await journal.get(key)).toMatchObject({ state: 'aborted', cleanupPending: true });
    expect(events).not.toContain('link');
  });
});
