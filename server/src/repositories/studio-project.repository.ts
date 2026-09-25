import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import type { Kysely, RawBuilder, Selectable } from 'kysely';
import { canWriteFork } from 'src/repositories/fork-write-guard.js';
import { DB } from 'src/schema/index.js';
import {
  StudioBundleUploadTable,
  StudioProjectCommentTable,
  StudioProjectRevisionTable,
  StudioProjectTable,
} from 'src/schema/tables/studio-project.table.js';

export type StudioProject = Selectable<StudioProjectTable>;
export type StudioProjectRevision = Selectable<StudioProjectRevisionTable>;
/** A history row: everything about a revision except the document itself. */
export type StudioProjectRevisionSummary = Omit<StudioProjectRevision, 'envelope'>;
export type StudioProjectComment = Selectable<StudioProjectCommentTable>;
export type StudioBundleUpload = Selectable<StudioBundleUploadTable>;

export type StudioBundleUploadCreate = {
  ownerId: string;
  path: string;
  sizeBytes: number;
  digest: string;
  originalFileName: string;
  manifest: Record<string, unknown>;
  expiresAt: Date;
};

/**
 * A project created with its first revision already in place: a duplicate of another project's
 * head, or a project read out of a portable bundle (FL-91).
 */
export type StudioProjectSeed = {
  ownerId: string;
  name: string;
  spaceId?: string | null;
  duplicatedFromId?: string | null;
  importedFromDigest?: string | null;
  /** The import job that creates it. Unique: a retried job finds the first attempt's project. */
  importOperationId?: string | null;
  revision: {
    authorId: string;
    envelope: Record<string, unknown>;
    digest: string;
    graphBytes: number;
    summary: Record<string, unknown>;
    requestKey: string | null;
  };
};

export type StudioProjectCreate = {
  ownerId: string;
  name: string;
  spaceId?: string | null;
};

export type StudioProjectPatch = {
  name?: string;
  spaceId?: string | null;
  /** A date archives, null unarchives. */
  archivedAt?: Date | null;
  thumbnailAssetId?: string | null;
  duplicatedFromId?: string | null;
  importedFromDigest?: string | null;
};

export type StudioPage = { take: number; skip: number };

/**
 * Which shelf of the project library a list shows (FL-91). `active` is the default and the only
 * one a reviewer ever sees; the archive and the trash are the owner's alone.
 */
export type StudioProjectState = 'active' | 'archived' | 'trashed';

/** `recent` orders by the last time the project was opened in an editor, then by change. */
export type StudioProjectSort = 'updated' | 'recent' | 'name';

export type StudioProjectListOptions = StudioPage & {
  state?: StudioProjectState;
  /** Case-insensitive substring of the name. */
  query?: string | null;
  sort?: StudioProjectSort;
};

export type StudioRevisionAppend = {
  projectId: string;
  /** The head the client saved against. The append is refused when the head has moved. */
  expectedRevision: number;
  authorId: string;
  /** The lease holder. The append is refused when this client does not hold a live lease. */
  leaseClientId: string;
  /** A successful save proves the writer is alive, so it also renews the lease. */
  leaseMs: number;
  envelope: Record<string, unknown>;
  digest: string;
  graphBytes: number;
  summary: Record<string, unknown>;
  requestKey: string | null;
  restoredFromRevision: number | null;
};

export type StudioRevisionAppendResult =
  | { status: 'appended'; revision: StudioProjectRevision }
  /** The head moved or the lease is not this client's. The caller re-reads to say which. */
  | { status: 'rejected' }
  /** `(projectId, requestKey)` already exists: a concurrent retry got there first. */
  | { status: 'duplicate-key' };

export type StudioLeaseAcquire = {
  userId: string;
  clientId: string;
  leaseMs: number;
  /** Take a live lease away from another client. The service allows it for the owner only. */
  takeover: boolean;
};

export type StudioCommentCreate = {
  projectId: string;
  authorId: string;
  revision: number;
  timeNum: number;
  timeDen: number;
  text: string;
  requestKey: string | null;
};

export type StudioCommentPatch = {
  text?: string;
  /** `null` clears the resolution; a user id records who resolved it. */
  resolvedById?: string | null;
};

/** A shared space row, as much of it as the project needs to decide whether it may be linked. */
export type StudioSpace = { id: string; kind: string; deletedAt: Date | null };

class DuplicateRequestKey extends Error {}

const isUniqueViolation = (error: unknown): boolean => (error as { code?: string } | null)?.code === '23505';

const leaseExpiry = (leaseMs: number) => sql<Date>`now() + ${sql.lit(leaseMs)} * interval '1 millisecond'`;

/**
 * Studio projects, revisions, leases and review comments (FL-89, `STU-202`).
 *
 * Every write that decides a race is a conditional statement whose guard is in the `WHERE`
 * clause, so two editors saving at once resolve in Postgres rather than in application code:
 * the head pointer moves exactly once, the loser updates zero rows and is told so, and nothing is
 * ever applied over somebody's work. Revision rows are never updated; history only appends.
 */
@Injectable()
export class StudioProjectRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  /* ------------------------------------------------------------------ */
  /* Projects                                                            */
  /* ------------------------------------------------------------------ */

  async create(project: StudioProjectCreate): Promise<StudioProject> {
    return this.db
      .insertInto('studio_project')
      .values({ ownerId: project.ownerId, name: project.name, spaceId: project.spaceId ?? null })
      .returningAll()
      .executeTakeFirstOrThrow() as unknown as Promise<StudioProject>;
  }

  /**
   * Create a project whose revision 1 is already written, in one transaction (FL-91).
   *
   * The lease is left free: nobody is editing a project that was just duplicated or imported, and
   * the first editor to open it takes the lease as usual. An import carries its job id; when a
   * retried job finds that id already taken, the first attempt's project is returned instead of a
   * second one being made.
   */
  async createWithRevision(seed: StudioProjectSeed): Promise<{ project: StudioProject; created: boolean }> {
    if (seed.importOperationId) {
      const existing = await this.getByImportOperation(seed.importOperationId);
      if (existing) {
        return { project: existing, created: false };
      }
    }

    try {
      const project = await this.db.transaction().execute(async (trx) => {
        const row = await trx
          .insertInto('studio_project')
          .values({
            ownerId: seed.ownerId,
            name: seed.name,
            spaceId: seed.spaceId ?? null,
            currentRevision: 1,
            duplicatedFromId: seed.duplicatedFromId ?? null,
            importedFromDigest: seed.importedFromDigest ?? null,
            importOperationId: seed.importOperationId ?? null,
          })
          .returningAll()
          .executeTakeFirstOrThrow();

        await trx
          .insertInto('studio_project_revision')
          .values({
            projectId: row.id,
            revision: 1,
            authorId: seed.revision.authorId,
            envelope: seed.revision.envelope,
            digest: seed.revision.digest,
            graphBytes: seed.revision.graphBytes,
            summary: seed.revision.summary,
            requestKey: seed.revision.requestKey,
            restoredFromRevision: null,
          })
          .execute();

        return row as unknown as StudioProject;
      });
      return { project, created: true };
    } catch (error) {
      if (seed.importOperationId && isUniqueViolation(error)) {
        const existing = await this.getByImportOperation(seed.importOperationId);
        if (existing) {
          return { project: existing, created: false };
        }
      }
      throw error;
    }
  }

  async getByImportOperation(operationId: string): Promise<StudioProject | undefined> {
    return this.db
      .selectFrom('studio_project')
      .selectAll()
      .where('importOperationId', '=', operationId)
      .executeTakeFirst() as unknown as Promise<StudioProject | undefined>;
  }

  /** Unscoped read. The service decides access from `ownerId` and `spaceId`; nothing else may. */
  getById(id: string): Promise<StudioProject | undefined> {
    return this.db
      .selectFrom('studio_project')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst() as unknown as Promise<StudioProject | undefined>;
  }

  /**
   * Projects this account owns plus projects shared into a space this account belongs to. The
   * membership test is the same `album_user` row the album access checks use, re-read here on
   * every call, so a revoked reviewer's list loses the project at once.
   */
  async listVisible(
    userId: string,
    page: StudioProjectListOptions,
  ): Promise<{ items: StudioProject[]; total: number }> {
    const state = page.state ?? 'active';
    let query = this.db.selectFrom('studio_project');

    if (state === 'active') {
      query = query
        .where('studio_project.deletedAt', 'is', null)
        .where('studio_project.archivedAt', 'is', null)
        .where((eb) =>
          eb.or([
            eb('studio_project.ownerId', '=', userId),
            eb.exists(
              eb
                .selectFrom('album_user')
                .innerJoin('album', 'album.id', 'album_user.albumId')
                .select('album_user.albumId')
                .whereRef('album_user.albumId', '=', 'studio_project.spaceId')
                .where('album_user.userId', '=', userId)
                .where('album.deletedAt', 'is', null),
            ),
          ]),
        );
    } else if (state === 'archived') {
      // The archive and the trash are the owner's shelves: a reviewer never sees either.
      query = query
        .where('studio_project.ownerId', '=', userId)
        .where('studio_project.deletedAt', 'is', null)
        .where('studio_project.archivedAt', 'is not', null);
    } else {
      query = query.where('studio_project.ownerId', '=', userId).where('studio_project.deletedAt', 'is not', null);
    }

    const term = page.query?.trim();
    if (term) {
      query = query.where('studio_project.name', 'ilike', `%${term.replaceAll(/[%_\\]/g, String.raw`\$&`)}%`);
    }

    const sort = page.sort ?? 'updated';
    const ordered = (() => {
      const selected = query.selectAll();
      switch (sort) {
        case 'recent': {
          return selected.orderBy(sql`coalesce("studio_project"."lastOpenedAt", "studio_project"."updatedAt")`, 'desc');
        }
        case 'name': {
          return selected.orderBy(sql`lower("studio_project"."name")`, 'asc');
        }
        default: {
          return selected.orderBy('studio_project.updatedAt', 'desc');
        }
      }
    })();

    const [items, total] = await Promise.all([
      ordered.orderBy('studio_project.id', 'desc').limit(page.take).offset(page.skip).execute(),
      query
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .executeTakeFirst()
        .then((row) => Number(row?.count ?? 0)),
    ]);

    return { items: items as unknown as StudioProject[], total };
  }

  async update(id: string, patch: StudioProjectPatch): Promise<StudioProject | undefined> {
    const values: Partial<
      Pick<
        StudioProject,
        'name' | 'spaceId' | 'archivedAt' | 'thumbnailAssetId' | 'duplicatedFromId' | 'importedFromDigest'
      >
    > = {};
    if (patch.name !== undefined) {
      values.name = patch.name;
    }
    if (patch.spaceId !== undefined) {
      values.spaceId = patch.spaceId;
    }
    if (patch.archivedAt !== undefined) {
      values.archivedAt = patch.archivedAt;
    }
    if (patch.thumbnailAssetId !== undefined) {
      values.thumbnailAssetId = patch.thumbnailAssetId;
    }
    if (patch.duplicatedFromId !== undefined) {
      values.duplicatedFromId = patch.duplicatedFromId;
    }
    if (patch.importedFromDigest !== undefined) {
      values.importedFromDigest = patch.importedFromDigest;
    }
    if (Object.keys(values).length === 0) {
      return this.getById(id);
    }

    return this.db
      .updateTable('studio_project')
      .set(values)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst() as unknown as Promise<StudioProject | undefined>;
  }

  /**
   * Permanent deletion. Revisions and comments cascade. Media operations keep their `projectId`
   * string for lineage, and no asset row is touched: a project references media, it never owns it.
   */
  async delete(id: string): Promise<void> {
    await this.db.deleteFrom('studio_project').where('id', '=', id).execute();
  }

  /* ------------------------------------------------------------------ */
  /* Lifecycle (FL-91)                                                   */
  /* ------------------------------------------------------------------ */

  /**
   * Move a project to the trash. Idempotent: a project already in the trash keeps its original
   * deadline rather than having the clock restarted. The lease is dropped so no editor keeps
   * writing to a project the owner has thrown away.
   */
  async trash(id: string, purgeAfter: Date): Promise<StudioProject | undefined> {
    return this.db
      .updateTable('studio_project')
      .set({
        deletedAt: sql<Date>`coalesce("deletedAt", now())`,
        purgeAfter: sql<Date>`coalesce("purgeAfter", ${purgeAfter})`,
        leaseHolderId: null,
        leaseClientId: null,
        leaseExpiresAt: null,
      })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst() as unknown as Promise<StudioProject | undefined>;
  }

  async untrash(id: string): Promise<StudioProject | undefined> {
    return this.db
      .updateTable('studio_project')
      .set({ deletedAt: null, purgeAfter: null })
      .where('id', '=', id)
      .where('deletedAt', 'is not', null)
      .returningAll()
      .executeTakeFirst() as unknown as Promise<StudioProject | undefined>;
  }

  /** Every trashed project of one owner, gone for good. Returns how many. */
  async emptyTrash(ownerId: string): Promise<number> {
    const result = await this.db
      .deleteFrom('studio_project')
      .where('ownerId', '=', ownerId)
      .where('deletedAt', 'is not', null)
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }

  /**
   * FL-90: the projects whose current revision names any of these assets. The graph is opaque
   * jsonb, so the id is matched as text; only well-formed UUIDs are searched, so a match is the
   * id itself and never a pattern.
   */
  async getIdsReferencingAssets(assetIds: readonly string[]): Promise<string[]> {
    const patterns = [...new Set(assetIds)]
      .filter((id) => /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(id))
      .map((id) => `%${id.toLowerCase()}%`);
    if (patterns.length === 0) {
      return [];
    }
    const rows = await this.db
      .selectFrom('studio_project')
      .innerJoin('studio_project_revision', (join) =>
        join
          .onRef('studio_project_revision.projectId', '=', 'studio_project.id')
          .onRef('studio_project_revision.revision', '=', 'studio_project.currentRevision'),
      )
      .select('studio_project.id')
      .where(
        sql<boolean>`lower("studio_project_revision"."envelope"::text) like any(array[${sql.join(patterns)}]::text[])`,
      )
      .execute();
    return rows.map((row) => row.id);
  }

  /** FL-90: the projects placed in an album or shared space. */
  async getIdsInSpace(spaceId: string): Promise<string[]> {
    const rows = await this.db.selectFrom('studio_project').select('id').where('spaceId', '=', spaceId).execute();
    return rows.map((row) => row.id);
  }

  /** FL-91: an account's stored workspace layout, from `immich_fork`. */
  async getWorkspace(
    userId: string,
  ): Promise<{ layout: Record<string, unknown>; engineRevision: string; savedAt: Date } | undefined> {
    const { rows } = await sql<{ layout: Record<string, unknown>; engineRevision: string; savedAt: Date }>`
      SELECT layout, "engineRevision", "savedAt" FROM immich_fork.studio_workspace_layout WHERE "userId" = ${userId}::uuid
    `.execute(this.db);
    return rows[0];
  }

  /** FL-91: store (replace) an account's workspace layout. */
  async saveWorkspace(
    userId: string,
    layout: Record<string, unknown>,
    engineRevision: string,
  ): Promise<{ savedAt: Date } | undefined> {
    // Not written while the fork schema is being handed off or returned (like every fork table).
    if (!(await canWriteFork(this.db))) {
      return undefined;
    }
    const { rows } = await sql<{ savedAt: Date }>`
      INSERT INTO immich_fork.studio_workspace_layout ("userId", layout, "engineRevision")
      VALUES (${userId}::uuid, ${JSON.stringify(layout)}::text::jsonb, ${engineRevision})
      ON CONFLICT ("userId") DO UPDATE
        SET layout = excluded.layout, "engineRevision" = excluded."engineRevision", "savedAt" = clock_timestamp()
      RETURNING "savedAt"
    `.execute(this.db);
    return rows[0];
  }

  /** FL-91: an account's layout goes with the account. */
  async deleteWorkspace(userId: string): Promise<void> {
    if (!(await canWriteFork(this.db))) {
      return;
    }
    await sql`DELETE FROM immich_fork.studio_workspace_layout WHERE "userId" = ${userId}::uuid`.execute(this.db);
  }

  /** The retention sweep: trashed projects whose deadline has passed. Returns the ids removed. */
  async deletePurgeable(now: Date, limit = 500): Promise<string[]> {
    const rows = await this.db
      .deleteFrom('studio_project')
      .where('id', 'in', (eb) =>
        eb
          .selectFrom('studio_project')
          .select('id')
          .where('deletedAt', 'is not', null)
          .where('purgeAfter', 'is not', null)
          .where('purgeAfter', '<', now)
          .limit(limit),
      )
      .returning('id')
      .execute();
    return rows.map((row) => row.id);
  }

  /** Drop whoever holds the lease. Used when a project is archived or trashed under an editor. */
  async clearLease(id: string): Promise<void> {
    await this.db
      .updateTable('studio_project')
      .set({ leaseHolderId: null, leaseClientId: null, leaseExpiresAt: null })
      .where('id', '=', id)
      .execute();
  }

  async getSpace(spaceId: string): Promise<StudioSpace | undefined> {
    return this.db
      .selectFrom('album')
      .select(['id', 'kind', 'deletedAt'])
      .where('id', '=', spaceId)
      .executeTakeFirst() as unknown as Promise<StudioSpace | undefined>;
  }

  /* ------------------------------------------------------------------ */
  /* Lease                                                               */
  /* ------------------------------------------------------------------ */

  /**
   * Take or renew the writer lease, atomically.
   *
   * Without `takeover` the update matches only when the lease is free, lapsed, or already this
   * client's, so two tabs racing for a free lease end with exactly one holder. With `takeover` the
   * guard is the ownership check alone. Either way the returned row is the truth afterwards;
   * `undefined` means somebody else holds it.
   */
  async acquireLease(projectId: string, options: StudioLeaseAcquire): Promise<StudioProject | undefined> {
    let query = this.db
      .updateTable('studio_project')
      .set({
        leaseHolderId: options.userId,
        leaseClientId: options.clientId,
        leaseExpiresAt: leaseExpiry(options.leaseMs),
        // A renewal by the holder is not an "open"; a fresh acquisition by any client is.
        lastOpenedAt: sql<Date>`case when "leaseClientId" = ${options.clientId} and "leaseExpiresAt" > now() then "lastOpenedAt" else now() end`,
      })
      .where('id', '=', projectId)
      .where('ownerId', '=', options.userId);

    if (!options.takeover) {
      query = query.where((eb) =>
        eb.or([
          eb('leaseExpiresAt', 'is', null),
          eb('leaseExpiresAt', '<', sql<Date>`now()`),
          eb.and([eb('leaseHolderId', '=', options.userId), eb('leaseClientId', '=', options.clientId)]),
        ]),
      );
    }

    return query.returningAll().executeTakeFirst() as unknown as Promise<StudioProject | undefined>;
  }

  /** Give the lease back. Only the holder can; anybody else's call changes nothing. */
  async releaseLease(projectId: string, userId: string, clientId: string): Promise<boolean> {
    const result = await this.db
      .updateTable('studio_project')
      .set({ leaseHolderId: null, leaseClientId: null, leaseExpiresAt: null })
      .where('id', '=', projectId)
      .where('leaseHolderId', '=', userId)
      .where('leaseClientId', '=', clientId)
      .executeTakeFirst();

    return Number(result.numUpdatedRows) === 1;
  }

  /* ------------------------------------------------------------------ */
  /* Revisions                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Append one revision and move the head, in one transaction.
   *
   * The head moves only when it still equals `expectedRevision` and the lease is live and this
   * client's. Both conditions are in the same `UPDATE`, so a stale save and a save from a lapsed
   * lease both match nothing and roll back with no revision row written. The unique
   * `(projectId, revision)` constraint is the backstop should two heads ever be computed at once,
   * and `(projectId, requestKey)` turns a concurrent duplicate retry into `duplicate-key` rather
   * than a second revision.
   */
  async appendRevision(append: StudioRevisionAppend): Promise<StudioRevisionAppendResult> {
    try {
      return await this.db.transaction().execute(async (trx) => {
        const head = await trx
          .updateTable('studio_project')
          .set({
            currentRevision: sql<number>`"currentRevision" + 1`,
            leaseExpiresAt: leaseExpiry(append.leaseMs),
          })
          .where('id', '=', append.projectId)
          .where('currentRevision', '=', append.expectedRevision)
          .where('leaseHolderId', '=', append.authorId)
          .where('leaseClientId', '=', append.leaseClientId)
          .where('leaseExpiresAt', '>', sql<Date>`now()`)
          .returning('currentRevision')
          .executeTakeFirst();

        if (!head) {
          return { status: 'rejected' as const };
        }

        try {
          const revision = await trx
            .insertInto('studio_project_revision')
            .values({
              projectId: append.projectId,
              revision: head.currentRevision,
              authorId: append.authorId,
              envelope: append.envelope,
              digest: append.digest,
              graphBytes: append.graphBytes,
              summary: append.summary,
              requestKey: append.requestKey,
              restoredFromRevision: append.restoredFromRevision,
            })
            .returningAll()
            .executeTakeFirstOrThrow();

          return { status: 'appended' as const, revision: revision as unknown as StudioProjectRevision };
        } catch (error) {
          if (isUniqueViolation(error)) {
            // Thrown so the head move rolls back with the failed insert.
            throw new DuplicateRequestKey();
          }
          throw error;
        }
      });
    } catch (error) {
      if (error instanceof DuplicateRequestKey) {
        return { status: 'duplicate-key' };
      }
      throw error;
    }
  }

  async getRevision(projectId: string, revision: number): Promise<StudioProjectRevision | undefined> {
    return this.db
      .selectFrom('studio_project_revision')
      .selectAll()
      .where('projectId', '=', projectId)
      .where('revision', '=', revision)
      .executeTakeFirst() as unknown as Promise<StudioProjectRevision | undefined>;
  }

  async getRevisionByRequestKey(projectId: string, requestKey: string): Promise<StudioProjectRevision | undefined> {
    return this.db
      .selectFrom('studio_project_revision')
      .selectAll()
      .where('projectId', '=', projectId)
      .where('requestKey', '=', requestKey)
      .executeTakeFirst() as unknown as Promise<StudioProjectRevision | undefined>;
  }

  /** Newest first, without the documents: the history list is metadata, the detail is a graph. */
  async listRevisions(
    projectId: string,
    page: StudioPage,
  ): Promise<{ items: StudioProjectRevisionSummary[]; total: number }> {
    const query = this.db.selectFrom('studio_project_revision').where('projectId', '=', projectId);

    const [items, total] = await Promise.all([
      query
        .select([
          'id',
          'projectId',
          'revision',
          'authorId',
          'digest',
          'graphBytes',
          'summary',
          'requestKey',
          'restoredFromRevision',
          'createdAt',
        ])
        .orderBy('revision', 'desc')
        .limit(page.take)
        .offset(page.skip)
        .execute(),
      query
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .executeTakeFirst()
        .then((row) => Number(row?.count ?? 0)),
    ]);

    return { items: items as unknown as StudioProjectRevisionSummary[], total };
  }

  /** Summaries of the revisions in `(fromExclusive, toInclusive]`, oldest first, for a diff. */
  async listRevisionSummariesBetween(
    projectId: string,
    fromExclusive: number,
    toInclusive: number,
    limit = 500,
  ): Promise<StudioProjectRevisionSummary[]> {
    return this.db
      .selectFrom('studio_project_revision')
      .select([
        'id',
        'projectId',
        'revision',
        'authorId',
        'digest',
        'graphBytes',
        'summary',
        'requestKey',
        'restoredFromRevision',
        'createdAt',
      ])
      .where('projectId', '=', projectId)
      .where('revision', '>', fromExclusive)
      .where('revision', '<=', toInclusive)
      .orderBy('revision', 'asc')
      .limit(limit)
      .execute() as unknown as Promise<StudioProjectRevisionSummary[]>;
  }

  /* ------------------------------------------------------------------ */
  /* Bundle uploads (FL-91)                                              */
  /* ------------------------------------------------------------------ */

  async createUpload(upload: StudioBundleUploadCreate): Promise<StudioBundleUpload> {
    return this.db
      .insertInto('studio_bundle_upload')
      .values({
        ownerId: upload.ownerId,
        path: upload.path,
        sizeBytes: String(upload.sizeBytes),
        digest: upload.digest,
        originalFileName: upload.originalFileName,
        manifest: upload.manifest,
        expiresAt: upload.expiresAt,
      })
      .returningAll()
      .executeTakeFirstOrThrow() as unknown as Promise<StudioBundleUpload>;
  }

  /** Owner-scoped. Somebody else's upload and an upload that never existed look the same. */
  async getUpload(id: string, ownerId: string): Promise<StudioBundleUpload | undefined> {
    return this.db
      .selectFrom('studio_bundle_upload')
      .selectAll()
      .where('id', '=', id)
      .where('ownerId', '=', ownerId)
      .executeTakeFirst() as unknown as Promise<StudioBundleUpload | undefined>;
  }

  async markUploadConsumed(id: string): Promise<void> {
    await this.db
      .updateTable('studio_bundle_upload')
      .set({ consumedAt: sql<Date>`coalesce("consumedAt", now())` })
      .where('id', '=', id)
      .execute();
  }

  /** Owner-scoped delete. Returns the row so the caller can remove its file. */
  async deleteUpload(id: string, ownerId: string): Promise<StudioBundleUpload | undefined> {
    return this.db
      .deleteFrom('studio_bundle_upload')
      .where('id', '=', id)
      .where('ownerId', '=', ownerId)
      .returningAll()
      .executeTakeFirst() as unknown as Promise<StudioBundleUpload | undefined>;
  }

  /** The sweep: uploads past their expiry, oldest first. Their files go with them. */
  async deleteExpiredUploads(now: Date, limit = 200): Promise<Array<{ id: string; path: string }>> {
    return this.db
      .deleteFrom('studio_bundle_upload')
      .where('id', 'in', (eb) =>
        eb
          .selectFrom('studio_bundle_upload')
          .select('id')
          .where('expiresAt', '<', now)
          .orderBy('expiresAt', 'asc')
          .limit(limit),
      )
      .returning(['id', 'path'])
      .execute();
  }

  /* ------------------------------------------------------------------ */
  /* Review comments                                                     */
  /* ------------------------------------------------------------------ */

  /** Returns `undefined` when `(projectId, requestKey)` already exists; the caller re-reads it. */
  async createComment(comment: StudioCommentCreate): Promise<StudioProjectComment | undefined> {
    try {
      return (await this.db
        .insertInto('studio_project_comment')
        .values({
          projectId: comment.projectId,
          authorId: comment.authorId,
          revision: comment.revision,
          timeNum: String(comment.timeNum),
          timeDen: String(comment.timeDen),
          text: comment.text,
          requestKey: comment.requestKey,
        })
        .returningAll()
        .executeTakeFirstOrThrow()) as unknown as StudioProjectComment;
    } catch (error) {
      if (isUniqueViolation(error)) {
        return undefined;
      }
      throw error;
    }
  }

  async getComment(projectId: string, id: string): Promise<StudioProjectComment | undefined> {
    return this.db
      .selectFrom('studio_project_comment')
      .selectAll()
      .where('projectId', '=', projectId)
      .where('id', '=', id)
      .executeTakeFirst() as unknown as Promise<StudioProjectComment | undefined>;
  }

  async getCommentByRequestKey(projectId: string, requestKey: string): Promise<StudioProjectComment | undefined> {
    return this.db
      .selectFrom('studio_project_comment')
      .selectAll()
      .where('projectId', '=', projectId)
      .where('requestKey', '=', requestKey)
      .executeTakeFirst() as unknown as Promise<StudioProjectComment | undefined>;
  }

  async listComments(projectId: string, page: StudioPage): Promise<{ items: StudioProjectComment[]; total: number }> {
    const query = this.db.selectFrom('studio_project_comment').where('projectId', '=', projectId);

    const [items, total] = await Promise.all([
      query.selectAll().orderBy('createdAt', 'asc').orderBy('id', 'asc').limit(page.take).offset(page.skip).execute(),
      query
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .executeTakeFirst()
        .then((row) => Number(row?.count ?? 0)),
    ]);

    return { items: items as unknown as StudioProjectComment[], total };
  }

  async updateComment(
    projectId: string,
    id: string,
    patch: StudioCommentPatch,
  ): Promise<StudioProjectComment | undefined> {
    const values: { text?: string; resolvedById?: string | null; resolvedAt?: RawBuilder<Date> | null } = {};
    if (patch.text !== undefined) {
      values.text = patch.text;
    }
    if (patch.resolvedById !== undefined) {
      values.resolvedById = patch.resolvedById;
      values.resolvedAt = patch.resolvedById === null ? null : sql<Date>`now()`;
    }
    if (Object.keys(values).length === 0) {
      return this.getComment(projectId, id);
    }

    return this.db
      .updateTable('studio_project_comment')
      .set(values)
      .where('projectId', '=', projectId)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst() as unknown as Promise<StudioProjectComment | undefined>;
  }

  async deleteComment(projectId: string, id: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom('studio_project_comment')
      .where('projectId', '=', projectId)
      .where('id', '=', id)
      .executeTakeFirst();

    return Number(result.numDeletedRows) === 1;
  }
}
