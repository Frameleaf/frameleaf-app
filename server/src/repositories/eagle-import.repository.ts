import { Injectable } from '@nestjs/common';
import { Insertable, Kysely, Updateable, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { DB } from 'src/schema/index.js';
import { EagleImportTable } from 'src/schema/tables/eagle-import.table.js';

/** The import's own columns that a run writes as it goes. */
export type EagleImportPatch = Omit<
  Updateable<EagleImportTable>,
  'id' | 'ownerId' | 'createdAt' | 'updatedAt' | 'leaseOwner' | 'leaseExpiresAt'
>;

const json = (value: unknown) => sql<never>`${JSON.stringify(value)}::text::jsonb`;

/** FL-653: the server's records of Eagle imports from a folder it can open. */
@Injectable()
export class EagleImportRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  /**
   * Starts an import, or answers the one already running for this account and library: the
   * partial unique index allows one running import per library, so two clicks or two tabs share it.
   */
  async create(input: Insertable<EagleImportTable>) {
    const created = await this.db
      .insertInto('eagle_import')
      .values({
        ...input,
        target: json(input.target),
        ...(input.existingTop && { existingTop: json(input.existingTop) }),
      })
      .onConflict((oc) =>
        oc
          .columns(['ownerId', 'libraryPath'])
          .where(sql<boolean>`"status" in ('running', 'stopping')`)
          .doNothing(),
      )
      .returningAll()
      .executeTakeFirst();
    return created ?? (await this.findActive(input.ownerId, input.libraryPath));
  }

  /** The import of this library running now for the account, if any. */
  findActive(ownerId: string, libraryPath: string) {
    return this.db
      .selectFrom('eagle_import')
      .selectAll()
      .where('ownerId', '=', ownerId)
      .where('libraryPath', '=', libraryPath)
      .where('status', 'in', ['running', 'stopping'])
      .executeTakeFirst();
  }

  getById(id: string) {
    return this.db.selectFrom('eagle_import').selectAll().where('id', '=', id).executeTakeFirst();
  }

  getOwned(id: string, ownerId: string) {
    return this.db
      .selectFrom('eagle_import')
      .selectAll()
      .where('id', '=', id)
      .where('ownerId', '=', ownerId)
      .executeTakeFirst();
  }

  /** The owner's latest import of this library that has more to do, to carry on. */
  findResumable(ownerId: string, libraryPath: string, fingerprint: string) {
    return this.db
      .selectFrom('eagle_import')
      .selectAll()
      .where('ownerId', '=', ownerId)
      .where('libraryPath', '=', libraryPath)
      .where('fingerprint', '=', fingerprint)
      .where((eb) => eb.or([eb('status', '!=', 'finished'), eb(sql`jsonb_array_length("failed")`, '>', 0)]))
      .orderBy('createdAt', 'desc')
      .executeTakeFirst();
  }

  /** The owner's imports that haven't finished, newest first. */
  listUnfinished(ownerId: string) {
    return this.db
      .selectFrom('eagle_import')
      .selectAll()
      .where('ownerId', '=', ownerId)
      .where('status', '!=', 'finished')
      .orderBy('updatedAt', 'desc')
      .limit(10)
      .execute();
  }

  /**
   * Starts it again from where it got to, with the choices made now. Undefined when it isn't
   * stopped or finished, or when another import of the library is already running.
   */
  restart(id: string, patch: Pick<EagleImportPatch, 'target' | 'existingTop'>) {
    const restarted = this.db
      .updateTable('eagle_import')
      .set({
        status: 'running',
        error: null,
        target: json(patch.target),
        existingTop: json(patch.existingTop ?? []),
        updatedAt: sql`now()`,
      })
      .where('id', '=', id)
      .where('status', 'in', ['stopped', 'finished'])
      .returningAll()
      .executeTakeFirst();
    return restarted.catch((error: unknown) => {
      if ((error as { constraint_name?: string })?.constraint_name === 'eagle_import_active_library_uq') {
        return;
      }
      throw error;
    });
  }

  /**
   * Stop: an import a worker holds becomes `stopping` and stops after the item in hand; one nobody
   * holds stops at once.
   */
  requestStop(id: string, ownerId: string) {
    return this.db
      .updateTable('eagle_import')
      .set({
        status: sql`case when "leaseExpiresAt" > now() then 'stopping' else 'stopped' end`,
        updatedAt: sql`now()`,
      })
      .where('id', '=', id)
      .where('ownerId', '=', ownerId)
      .where('status', 'in', ['running', 'stopping'])
      .returningAll()
      .executeTakeFirst();
  }

  /** Takes the oldest import that is waiting for a worker, or whose worker's lease ran out. */
  claim(workerId: string, leaseMs: number) {
    return this.db
      .updateTable('eagle_import')
      .set({ leaseOwner: workerId, leaseExpiresAt: sql`now() + ${`${leaseMs} milliseconds`}::interval` })
      .where(
        'id',
        '=',
        (eb) =>
          eb
            .selectFrom('eagle_import')
            .select('id')
            .where('status', 'in', ['running', 'stopping'])
            .where((inner) =>
              inner.or([inner('leaseExpiresAt', 'is', null), inner('leaseExpiresAt', '<', sql<Date>`now()`)]),
            )
            .orderBy('updatedAt')
            .limit(1)
            .forUpdate()
            .skipLocked() as never,
      )
      .returningAll()
      .executeTakeFirst();
  }

  /** Keeps the lease and answers the import's status, or undefined when another worker has it now. */
  async renew(id: string, workerId: string, leaseMs: number) {
    const row = await this.db
      .updateTable('eagle_import')
      .set({ leaseExpiresAt: sql`now() + ${`${leaseMs} milliseconds`}::interval` })
      .where('id', '=', id)
      .where('leaseOwner', '=', workerId)
      .returning('status')
      .executeTakeFirst();
    return row?.status;
  }

  /** Writes what the run has done so far, while it still holds the lease. */
  async save(id: string, workerId: string, patch: EagleImportPatch) {
    const { albums, tagIds, failed, recent, target, existingTop, ...rest } = patch;
    await this.db
      .updateTable('eagle_import')
      .set({
        ...rest,
        ...(albums !== undefined && { albums: json(albums) }),
        ...(tagIds !== undefined && { tagIds: json(tagIds) }),
        ...(failed !== undefined && { failed: json(failed) }),
        ...(recent !== undefined && { recent: json(recent) }),
        ...(target !== undefined && { target: json(target) }),
        ...(existingTop !== undefined && { existingTop: json(existingTop) }),
        updatedAt: sql`now()`,
      })
      .where('id', '=', id)
      .where('leaseOwner', '=', workerId)
      .execute();
  }

  /** Ends the run: `stopping` becomes `stopped`, and the lease is let go. */
  async finish(id: string, workerId: string, status: 'stopped' | 'finished', error?: string) {
    await this.db
      .updateTable('eagle_import')
      .set({
        // A stop that arrived after the run's last check stays a stop.
        status: sql`case when "status" in ('stopping', 'stopped') then 'stopped' else ${status} end`,
        error: error ?? null,
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: sql`now()`,
      })
      .where('id', '=', id)
      .where('leaseOwner', '=', workerId)
      .execute();
  }

  /** Lets the import go without ending it, so a worker takes it again (the server is restarting). */
  async release(id: string, workerId: string) {
    await this.db
      .updateTable('eagle_import')
      .set({ leaseOwner: null, leaseExpiresAt: null })
      .where('id', '=', id)
      .where('leaseOwner', '=', workerId)
      .execute();
  }

  outcomes(importId: string) {
    return this.db
      .selectFrom('eagle_import_item')
      .select(['itemId', 'assetId', 'duplicate'])
      .where('importId', '=', importId)
      .execute();
  }

  async counts(importId: string) {
    const row = await this.db
      .selectFrom('eagle_import_item')
      .select((eb) => [
        eb.fn.countAll<number>().as('done'),
        eb.fn.sum<number>(sql`case when "duplicate" then 1 else 0 end`).as('already'),
      ])
      .where('importId', '=', importId)
      .executeTakeFirstOrThrow();
    return { done: Number(row.done), already: Number(row.already ?? 0) };
  }

  /** Records an item, only while `workerId` still holds the import. False once it lost the lease. */
  async addOutcome(importId: string, workerId: string, itemId: string, assetId: string, duplicate: boolean) {
    const row = await this.db
      .insertInto('eagle_import_item')
      .columns(['importId', 'itemId', 'assetId', 'duplicate'])
      .expression((eb) =>
        eb
          .selectFrom('eagle_import')
          .select([
            'eagle_import.id',
            sql<string>`${itemId}::varchar`.as('itemId'),
            sql<string>`${assetId}::uuid`.as('assetId'),
            sql<boolean>`${duplicate}::boolean`.as('duplicate'),
          ])
          .where('eagle_import.id', '=', importId)
          .where('eagle_import.leaseOwner', '=', workerId),
      )
      .onConflict((oc) => oc.columns(['importId', 'itemId']).doUpdateSet({ assetId, duplicate }))
      .returning('id')
      .executeTakeFirst();
    return !!row;
  }
}
