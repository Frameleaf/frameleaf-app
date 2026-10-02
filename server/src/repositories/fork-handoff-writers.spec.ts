import { ConflictException } from '@nestjs/common';
import { Kysely } from 'kysely';
import { StudioExportScope, StudioExportVersionState } from 'src/enum.js';
import {
  MEDIA_OPERATION_HANDOFF_REFUSAL,
  MediaOperationRepository,
} from 'src/repositories/media-operation.repository.js';
import { PRESERVATION_HANDOFF_REFUSAL, PreservationRepository } from 'src/repositories/preservation.repository.js';
import { RENDER_WORKER_HANDOFF_REFUSAL, RenderWorkerRepository } from 'src/repositories/render-worker.repository.js';
import { STUDIO_EXPORT_HANDOFF_REFUSAL, StudioExportRepository } from 'src/repositories/studio-export.repository.js';
import { STUDIO_PROJECT_HANDOFF_REFUSAL, StudioProjectRepository } from 'src/repositories/studio-project.repository.js';
import { TAKEOUT_HANDOFF_REFUSAL, TakeoutRepository } from 'src/repositories/takeout.repository.js';
import { DB } from 'src/schema/index.js';
import { forkGuardAnswer, scriptedKysely, type ScriptedAnswer, type ScriptedQuery } from 'test/scripted-kysely.js';

const id = '00000000-0000-4000-a000-000000000001';

type Writer = {
  repository: string;
  message: string;
  table: string;
  write: (db: Kysely<DB>) => Promise<unknown>;
  answer?: (query: ScriptedQuery) => ScriptedAnswer;
};

/**
 * FL-44 (FN-304): Frameleaf's public-schema writers refuse while a database handoff holds the
 * schema, before any statement touches their tables, and take the guard ahead of the write otherwise.
 */
const writers: Writer[] = [
  {
    repository: 'media operations: submit',
    message: MEDIA_OPERATION_HANDOFF_REFUSAL,
    table: 'media_operation',
    write: (db) => new MediaOperationRepository(db).create({ ownerId: id } as never),
  },
  {
    repository: 'media operations: heartbeat',
    message: MEDIA_OPERATION_HANDOFF_REFUSAL,
    table: 'media_operation',
    write: (db) => new MediaOperationRepository(db).heartbeat(id, id, 60_000),
  },
  {
    repository: 'media operations: complete',
    message: MEDIA_OPERATION_HANDOFF_REFUSAL,
    table: 'media_operation',
    write: (db) => new MediaOperationRepository(db).complete(id, id, { resultAssetId: null }),
  },
  {
    repository: 'Studio projects: editor lease',
    message: STUDIO_PROJECT_HANDOFF_REFUSAL,
    table: 'studio_project',
    write: (db) =>
      new StudioProjectRepository(db).acquireLease(id, { userId: id, clientId: 'tab', leaseMs: 90_000 } as never),
  },
  {
    repository: 'Studio projects: release lease',
    message: STUDIO_PROJECT_HANDOFF_REFUSAL,
    table: 'studio_project',
    write: (db) => new StudioProjectRepository(db).clearLease(id),
  },
  {
    repository: 'Studio exports: fail a version',
    message: STUDIO_EXPORT_HANDOFF_REFUSAL,
    table: 'studio_export_version',
    write: (db) =>
      new StudioExportRepository(db, undefined as never, undefined as never, undefined as never).markFailed(id, {
        errorCode: 'gpu',
        error: 'lost',
      }),
  },
  {
    repository: 'Studio exports: remove an output',
    message: STUDIO_EXPORT_HANDOFF_REFUSAL,
    table: 'studio_export_version',
    answer: ({ sql }) => {
      if (sql.startsWith('select * from "studio_export_version"')) {
        return {
          rows: [
            {
              id,
              ownerId: id,
              projectId: id,
              state: StudioExportVersionState.Failed,
              scope: StudioExportScope.Project,
              outputPath: `/data/exports/${id}/output.mp4`,
              outputChecksum: Buffer.alloc(32, 1),
              outputSizeInBytes: 10,
              outputRemovedAt: null,
            },
          ],
        };
      }
      if (sql.startsWith('select "id" from "studio_export_version"') && sql.endsWith('for update')) {
        return { rows: [{ id }] };
      }
      if (sql.includes('count(')) {
        // The retiring export is the only retained reference; every other reference count is zero.
        return { rows: [{ count: sql.includes('public.studio_export_version') ? '1' : '0' }] };
      }
    },
    write: (db) =>
      new StudioExportRepository(db, undefined as never, undefined as never, undefined as never).markOutputRemoved(
        id,
        async () => {},
      ),
  },
  {
    repository: 'preservation: create a package',
    message: PRESERVATION_HANDOFF_REFUSAL,
    table: 'preservation_package',
    write: (db) => new PreservationRepository(db).createPackage({ ownerId: id } as never),
  },
  {
    repository: 'preservation: reset verification',
    message: PRESERVATION_HANDOFF_REFUSAL,
    table: 'preservation_item',
    write: (db) => new PreservationRepository(db).resetVerification(id),
  },
  {
    repository: 'render workers: enrol',
    message: RENDER_WORKER_HANDOFF_REFUSAL,
    table: 'render_worker',
    write: (db) => new RenderWorkerRepository(db).createWorker({ name: 'Box' } as never),
  },
  {
    repository: 'render workers: session use',
    message: RENDER_WORKER_HANDOFF_REFUSAL,
    table: 'render_worker_session',
    write: (db) => new RenderWorkerRepository(db).touchSession(id),
  },
  {
    repository: 'Takeout: finish an item',
    message: TAKEOUT_HANDOFF_REFUSAL,
    table: 'takeout_item',
    write: (db) => new TakeoutRepository(db).itemDone(id, 'imported' as never),
  },
  {
    repository: 'Takeout: create an import',
    message: TAKEOUT_HANDOFF_REFUSAL,
    table: 'takeout_import',
    write: (db) => new TakeoutRepository(db).create(id, 'Import', {} as never),
  },
];

const writesTo = (sql: string, table: string) =>
  new RegExp(String.raw`^\s*(insert into|update|delete from)\s+"?${table}"?\b`, 'i').test(sql);

describe('Frameleaf public-table writers during database handoff (FL-44)', () => {
  it.each(writers)('$repository refuses while a handoff is prepared', async ({ message, table, write }) => {
    const { db, queries } = scriptedKysely(forkGuardAnswer({ phase: 'ready', handoff: true }));

    await expect(write(db)).rejects.toThrow(new ConflictException(message));
    expect(queries.some(({ sql }) => writesTo(sql, table))).toBe(false);
    expect(queries.at(-1)?.sql).toBe('rollback');
  });

  it.each(writers)('$repository refuses once the database was handed over', async ({ message, write }) => {
    const { db } = scriptedKysely(forkGuardAnswer({ phase: 'inactive' }));

    await expect(write(db)).rejects.toThrow(message);
  });

  it.each(writers)('$repository takes the guard before it writes', async ({ table, write, answer }) => {
    const guardAnswer = forkGuardAnswer({ phase: 'active' });
    const { db, queries } = scriptedKysely((query) => guardAnswer(query) ?? answer?.(query));

    await write(db).catch(() => {
      // Other writers receive no domain rows; inspect their issued SQL even when they reject.
    });

    const statements = queries.map(({ sql }) => sql);
    const written = statements.findIndex((sql) => writesTo(sql, table));
    const transaction = statements.lastIndexOf('begin', written);
    const guard = statements.findIndex(
      (sql, index) => index > transaction && sql.includes('FROM immich_fork.state WHERE id = 1 FOR SHARE'),
    );
    expect(transaction).toBeGreaterThanOrEqual(0);
    expect(guard).toBeGreaterThan(transaction);
    expect(written).toBeGreaterThan(guard);
  });
});
