import { Kysely, sql } from 'kysely';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, chown, link, lstat, mkdir, mkdtemp, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DB } from 'src/schema/index.js';
import type { FilePort, JournalPort, PreparedImport, PublicationKey } from 'src/utils/studio-import-publication.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { StudioImportPublicationRepository } from 'src/repositories/studio-import-publication.repository.js';
import { StudioProjectRepository } from 'src/repositories/studio-project.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { retainImport } from 'src/services/studio-import-publication.service.js';
import { IMPORT_FAULT_POINTS } from 'test/fixtures/studio-import-barrier-faults.js';
import { DECLARATION } from 'test/fixtures/studio-import-retention.js';
import { getLibraryQueueDB as createRetentionTestDatabase } from 'test/medium/library-queue-database.js';
import { newMediumService } from 'test/medium.factory.js';

// Real disposable SQL and temporary bytes, with explicitly modelled FilePort barriers.
// These cases exercise orchestration/transaction boundaries; they cannot qualify storage durability.
let db: Kysely<DB>;
let root: string;
let crashClosureUnknown = false;
const paths = new Set<string>();
beforeAll(async () => {
  db = await createRetentionTestDatabase(process.env.FL111_CRASH_OWNER ? 1 : 2, () => crashClosureUnknown);
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
  prepare: () => {
    events.push('model-stage/file/ancestor-barriers');
    return Promise.resolve(file);
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

// Opt-in only: the enclosing Root-owned Linux runtime window supplies the private
// cgroup/guardian record. An absent lane is pending coverage, never a crash pass.
describe.skipIf(!process.env.FL111_CRASH_OWNER)(
  'real Linux worker crash and restarted durable-journal recovery',
  () => {
    it.each(IMPORT_FAULT_POINTS)(
      'recovers observed SQL and exact file identities after %s',
      async (point) => {
        expect(process.platform).toBe('linux');
        expect(process.getuid!()).toBe(0);
        const admission = spawnSync(
          '/usr/bin/python3',
          [resolve('test/fixtures/studio-import-crash-driver.py'), '--admit', process.env.FL111_CRASH_OWNER!],
          {
            encoding: 'utf8',
            timeout: 15_000,
            maxBuffer: 65_536,
            env: { PATH: '/usr/bin:/bin' },
          },
        );
        expect(admission.error).toBeUndefined();
        expect(admission.status, 'Root lane admission must pass before fixture allocation').toBe(0);
        const owner = JSON.parse(admission.stdout);
        const { key, journal } = await setup();
        const caseRoot = await mkdtemp(join(owner.scratchRoot, 'case-'));
        const exportRoot = join(caseRoot, 'exports');
        const ownerRoot = join(exportRoot, key.ownerId);
        const imports = join(ownerRoot, 'studio-imports');
        const incoming = join(imports, 'incoming');
        const project = join(imports, key.projectId);
        const stagedPath = join(incoming, `${key.publicationId}.upload`);
        const targetPath = join(project, `${key.importId}.mp4`);
        const foreignPath = join(project, `${randomUUID()}.mp4`);
        await chmod(caseRoot, 0o755);
        await mkdir(incoming, { recursive: true, mode: 0o700 });
        await mkdir(project, { mode: 0o700 });
        for (const path of [exportRoot, ownerRoot, imports, incoming, project]) {
          await chmod(path, 0o700);
          await chown(path, owner.workerUid, owner.workerGid);
        }
        const bytes = Buffer.from('test');
        const checksum = createHash('sha256').update(bytes).digest('hex');
        const declaration = {
          ...DECLARATION,
          checksum,
          processingProvenance: { ...DECLARATION.processingProvenance, outputSha256: checksum },
        };
        for (const path of [stagedPath, foreignPath]) {
          await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
          await chown(path, owner.workerUid, owner.workerGid);
        }
        const stageIdentity = await lstat(stagedPath, { bigint: true });
        const foreignIdentity = await lstat(foreignPath, { bigint: true });
        const databaseName = (await sql<{ name: string }>`select current_database() name`.execute(db)).rows[0].name;
        console.info('FL111_CRASH_FIXTURE', JSON.stringify({ point, databaseName, caseRoot }));
        const upload = { key, incoming: stagedPath, declaration };
        const task = {
          point,
          root: exportRoot,
          upload,
          databaseName,
          sourceHead: owner.sourceHead,
          workerUid: owner.workerUid,
          workerGid: owner.workerGid,
          node: process.execPath,
          tsx: import.meta.resolve('tsx'),
        };
        const run = (mode: 'publish' | 'recover') => {
          crashClosureUnknown = true;
          const result = spawnSync(
            '/usr/bin/python3',
            [resolve('test/fixtures/studio-import-crash-driver.py'), process.env.FL111_CRASH_OWNER!],
            {
              input: JSON.stringify({ ...task, mode }) + '\n',
              encoding: 'utf8',
              timeout: 90_000,
              maxBuffer: 65_536,
              env: { PATH: '/usr/bin:/bin', IMMICH_TEST_POSTGRES_URL: process.env.IMMICH_TEST_POSTGRES_URL! },
            },
          );
          // No recovery or fixture deletion after UNKNOWN ownership/closure.
          expect(result.error, 'Owned crash driver must complete within its Root window').toBeUndefined();
          expect(result.status, 'Crash driver refused; preserve the fixture for its registered guardian').toBe(0);
          const receipt = JSON.parse(result.stdout);
          expect(receipt).toMatchObject({
            point,
            cleanup: 'kernel-cgroup-populated-zero',
            populatedAfterKill: 0,
            boundary: 'process-restart-only',
            sourceHead: owner.sourceHead,
          });
          crashClosureUnknown = false;
          return receipt;
        };
        expect(run('publish')).toMatchObject({ barrierObserved: true, descendantObserved: true, workerExitCode: -9 });
        const published = ['publication-commit', 'stage-unlink', 'cleanup-namespace-barrier'].includes(point);
        const prepared = !['stage-file-barrier', 'stage-namespace-barrier'].includes(point);
        const linked = !['stage-file-barrier', 'stage-namespace-barrier', 'prepare-commit'].includes(point);
        const stageRemoved = ['stage-unlink', 'cleanup-namespace-barrier'].includes(point);
        const exists = async (path: string) => {
          try {
            await lstat(path);
            return true;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            return false;
          }
        };
        expect(await journal.get(key)).toMatchObject({
          state: published ? 'published' : prepared ? 'preparing' : 'registered',
          cleanupPending: prepared,
        });
        expect(await rows(key)).toHaveLength(published ? 1 : 0);
        expect(await exists(stagedPath)).toBe(!stageRemoved);
        expect(await exists(targetPath)).toBe(linked);
        if (linked) {
          const target = await lstat(targetPath, { bigint: true });
          expect([target.dev, target.ino, target.size]).toEqual([
            stageIdentity.dev,
            stageIdentity.ino,
            stageIdentity.size,
          ]);
          expect(
            createHash('sha256')
              .update(await readFile(targetPath))
              .digest('hex'),
          ).toBe(checksum);
        }
        expect(run('recover')).toMatchObject({ restartedRecoveryCompleted: true, workerExitCode: 0 });
        expect(await journal.get(key)).toMatchObject({
          state: published ? 'published' : 'aborted',
          cleanupPending: false,
        });
        expect(await rows(key)).toHaveLength(published ? 1 : 0);
        expect(await exists(stagedPath)).toBe(false);
        expect(await exists(targetPath)).toBe(published);
        if (published) {
          const imported = (await rows(key))[0];
          expect(imported).toMatchObject({
            processingProvenance: declaration.processingProvenance,
            checksum,
            path: targetPath,
            ownerId: key.ownerId,
            projectId: key.projectId,
          });
          expect(
            createHash('sha256')
              .update(await readFile(targetPath))
              .digest('hex'),
          ).toBe(checksum);
          const target = await lstat(targetPath, { bigint: true });
          expect([target.dev, target.ino, target.nlink]).toEqual([stageIdentity.dev, stageIdentity.ino, 1n]);
        }
        const foreignAfter = await lstat(foreignPath, { bigint: true });
        expect([foreignAfter.dev, foreignAfter.ino, foreignAfter.size, foreignAfter.nlink]).toEqual([
          foreignIdentity.dev,
          foreignIdentity.ino,
          foreignIdentity.size,
          foreignIdentity.nlink,
        ]);
        expect(await readFile(foreignPath)).toEqual(bytes);
        // Success-only, exact fixture-owned paths; failure keeps its namespace for guarded handoff.
        if (published) await unlink(targetPath);
        await unlink(foreignPath);
        for (const path of [project, incoming, imports, ownerRoot, exportRoot, caseRoot]) await rmdir(path);
      },
      180_000,
    );
  },
);
