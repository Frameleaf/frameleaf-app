// Loaded only after the builtin bootstrap verifies admission.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { open, readFile, unlink } from 'node:fs/promises';
import type { DB } from 'src/schema/index.js';
import type { ImportFaultPoint } from 'src/utils/studio-import-faults.js';
import type { RetentionUpload } from 'src/utils/studio-import-publication.js';

interface CrashTask {
  controlGroup: string;
  mode: 'publish' | 'recover';
  databaseName: string;
  root: string;
  point: ImportFaultPoint;
  upload: RetentionUpload;
}

export async function runCrashWorker(task: CrashTask) {
  const emit = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
  assert.equal((await readFile('/proc/self/cgroup', 'utf8')).trim(), `0::${task.controlGroup}`);
  assert.ok(['publish', 'recover'].includes(task.mode));
  assert.ok(/^[a-z0-9_]+$/.test(task.databaseName) && task.databaseName.startsWith('frameleaf_'));
  const url = new URL(process.env.IMMICH_TEST_POSTGRES_URL!);
  assert.ok(['localhost', '127.0.0.1'].includes(url.hostname));
  url.pathname = `/${task.databaseName}`;

  const [
    { createPostgres },
    { Kysely },
    { PostgresJSDialect },
    { boundPoolClose },
    { boundExecutionReservations },
    { StudioImportPublicationRepository },
    { LinuxDurabilityAdapter, StudioImportFileRepository },
    { retainImport },
    { barrierFaults },
    { StorageCore },
    { assertOwnerRestorePath, assertOwnerRestoreFile },
  ] = await Promise.all([
    import('@frameleaf/sql-tools'),
    import('kysely'),
    import('kysely-postgres-js'),
    import('src/utils/database.js'),
    import('src/utils/execution-database.js'),
    import('src/repositories/studio-import-publication.repository.js'),
    import('src/repositories/studio-import-file.repository.js'),
    import('src/services/studio-import-publication.service.js'),
    import('test/fixtures/studio-import-barrier-faults.js'),
    import('src/cores/storage.core.js'),
    import('src/utils/cloud-backup-owner-path.js'),
  ]);
  const client = boundExecutionReservations(
    createPostgres({
      connection: { connectionType: 'url', url: url.href },
      maxConnections: 1,
      connectTimeoutSeconds: 5,
      statementTimeoutMs: 5000,
      lockTimeoutMs: 3000,
    }),
  );
  const db = new Kysely<DB>({ dialect: new PostgresJSDialect({ postgres: boundPoolClose(client) }) });
  const root = await open(task.root, 'r');
  let rootIdentity: { dev: string; ino: string; size: number };
  let mount: string;
  try {
    const stat = await root.stat({ bigint: true });
    assert.ok(stat.isDirectory() && stat.uid === BigInt(process.getuid!()) && (stat.mode & 0o077n) === 0n);
    rootIdentity = { dev: String(stat.dev), ino: String(stat.ino), size: Number(stat.size) };
    const observedMount = /^mnt_id:\s+(\d+)$/m.exec(await readFile(`/proc/self/fdinfo/${root.fd}`, 'utf8'))?.[1];
    assert.ok(observedMount);
    mount = observedMount;
  } finally {
    await root.close();
  }
  // Deliberately synthetic qualification injection: actual Linux syscalls, process restart ONLY.
  const adapter = new LinuxDurabilityAdapter({
    root: task.root,
    anchor: task.root,
    qualification: () =>
      Promise.resolve({
        root: task.root,
        anchor: task.root,
        rootIdentity,
        anchorIdentity: rootIdentity,
        rootMountId: mount,
        anchorMountId: mount,
        namespaceIsolated: true,
        evidenceId: 'TEST-PROCESS-RESTART-ONLY-NOT-STORAGE-QUALIFICATION',
      }),
  });
  const journal = new StudioImportPublicationRepository(db);
  if (task.mode === 'recover') {
    const files = new StudioImportFileRepository(adapter);
    const before = await journal.get(task.upload.key);
    assert.ok(before);
    if (before.state !== 'published') await journal.cancel(task.upload.key);
    await journal.release(task.upload.key, (file, role) => files.release(file, role));
    if (before.state === 'registered') {
      // Accelerated stale-file threshold; production owner/path/reference guards still run.
      const { dirname } = await import('node:path');
      StorageCore.setMediaLocation(dirname(task.root));
      assert.equal(StorageCore.getBaseFolder((await import('src/enum.js')).StorageFolder.Exports), task.root);
      await journal.cleanupIncoming(
        task.upload.key.ownerId,
        task.upload.incoming,
        new Date(Date.now() + 1),
        async (identity) => {
          await assertOwnerRestorePath([task.root], task.upload.incoming);
          await assertOwnerRestoreFile(task.upload.incoming, identity);
          await unlink(task.upload.incoming);
        },
      );
    }
    await db.destroy();
    emit({ state: 'recovered', point: task.point });
  } else {
    // A detached descendant proves that direct-child exit/process-group checks are insufficient.
    const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: 'ignore',
      env: {},
    });
    assert.ok(descendant.pid);
    await new Promise<void>((resolve, reject) => {
      descendant.once('spawn', resolve);
      descendant.once('error', reject);
    });
    assert.equal((await readFile(`/proc/${descendant.pid}/cgroup`, 'utf8')).trim(), `0::${task.controlGroup}`);
    const faults = barrierFaults(task.point, (point) => {
      emit({ state: 'barrier', point, descendantPid: descendant.pid });
      return Promise.resolve();
    });
    await retainImport(journal, new StudioImportFileRepository(adapter, faults), task.upload, faults);
    throw new Error('crash_barrier_not_reached');
  }
}
