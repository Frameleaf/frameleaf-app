import { Injectable } from '@nestjs/common';
import { Kysely, RawBuilder, Selectable, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { DB } from 'src/schema/index.js';
import {
  StudioProjectCommentTable,
  StudioProjectRevisionTable,
  StudioProjectTable,
} from 'src/schema/tables/studio-project.table.js';

export type StudioProject = Selectable<StudioProjectTable>;
export type StudioProjectRevision = Selectable<StudioProjectRevisionTable>;
/** A history row: everything about a revision except the document itself. */
export type StudioProjectRevisionSummary = Omit<StudioProjectRevision, 'envelope'>;
export type StudioProjectComment = Selectable<StudioProjectCommentTable>;

export type StudioProjectCreate = {
  ownerId: string;
  name: string;
  spaceId?: string | null;
};

export type StudioProjectPatch = {
  name?: string;
  spaceId?: string | null;
};

export type StudioPage = { take: number; skip: number };

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
export type StudioSpace = { id: string; ownerId: string; kind: string; deletedAt: Date | null };

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

  /** Unscoped read. The service decides access from `ownerId` and `spaceId`; nothing else may. */
  async getById(id: string): Promise<StudioProject | undefined> {
    return this.db.selectFrom('studio_project').selectAll().where('id', '=', id).executeTakeFirst() as unknown as
      | StudioProject
      | undefined;
  }

  /**
   * Projects this account owns plus projects shared into a space this account belongs to. The
   * membership test is the same `album_user` row the album access checks use, re-read here on
   * every call, so a revoked reviewer's list loses the project at once.
   */
  async listVisible(userId: string, page: StudioPage): Promise<{ items: StudioProject[]; total: number }> {
    const query = this.db.selectFrom('studio_project').where((eb) =>
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

    const [items, total] = await Promise.all([
      query.selectAll().orderBy('updatedAt', 'desc').orderBy('id', 'desc').limit(page.take).offset(page.skip).execute(),
      query
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .executeTakeFirst()
        .then((row) => Number(row?.count ?? 0)),
    ]);

    return { items: items as unknown as StudioProject[], total };
  }

  async update(id: string, patch: StudioProjectPatch): Promise<StudioProject | undefined> {
    const values: Partial<Pick<StudioProject, 'name' | 'spaceId'>> = {};
    if (patch.name !== undefined) {
      values.name = patch.name;
    }
    if (patch.spaceId !== undefined) {
      values.spaceId = patch.spaceId;
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

  /** Revisions and comments cascade. Media operations keep their `projectId` string for lineage. */
  async delete(id: string): Promise<void> {
    await this.db.deleteFrom('studio_project').where('id', '=', id).execute();
  }

  async getSpace(spaceId: string): Promise<StudioSpace | undefined> {
    return this.db
      .selectFrom('album')
      .select(['id', 'ownerId', 'kind', 'deletedAt'])
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

  async updateComment(projectId: string, id: string, patch: StudioCommentPatch): Promise<StudioProjectComment | undefined> {
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
