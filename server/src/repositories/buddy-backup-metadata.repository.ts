import { Kysely, type Transaction, sql } from 'kysely';
import type { DB } from 'src/schema/index.js';
import type { BuddyAlbum, BuddyAlbumPlan, BuddyMetadata } from 'src/utils/buddy-backup-metadata.js';
import { isValidAlbumIcon } from 'src/constants/album-icons.js';
import { AlbumKind, AlbumUserRole, AssetOrder, MediaOperationKind, MediaOperationStatus } from 'src/enum.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';

import { buddyAlbumState, readBuddyMetadata } from 'src/utils/buddy-backup-metadata.js';
/** Source-library metadata only. Received peer vaults never enter these queries or the library. */
export class BuddyBackupMetadataRepository {
  constructor(private db: Kysely<DB>) {}
  private async albums(ids?: string[], lock = false, liveOnly = false) {
    if (ids?.length === 0) {
      return new Map<
        string,
        {
          album: BuddyAlbum;
          deleted: boolean;
        }
      >();
    }
    let query = this.db
      .selectFrom('album')
      .select([
        'id',
        'albumName',
        'description',
        'albumThumbnailAssetId',
        'order',
        'parentId',
        'kind',
        'icon',
        'sortOrder',
        'deletedAt',
      ]);
    if (ids) {
      query = query.where('id', 'in', ids);
    }
    if (liveOnly) {
      query = query.where('deletedAt', 'is', null);
    }
    if (lock) {
      query = query.forUpdate().noWait();
    }
    const rows = await query.execute();
    if (rows.length === 0) {
      return new Map<
        string,
        {
          album: BuddyAlbum;
          deleted: boolean;
        }
      >();
    }
    let ownersQuery = this.db
      .selectFrom('album_user')
      .select(['albumId', 'userId'])
      .where(
        'albumId',
        'in',
        rows.map(({ id }) => id),
      )
      .where('role', '=', AlbumUserRole.Owner);
    if (lock) {
      ownersQuery = ownersQuery.forShare().noWait();
    }
    const owners = await ownersQuery.execute();
    const result = new Map<
      string,
      {
        album: BuddyAlbum;
        deleted: boolean;
      }
    >();
    const byAlbum = new Map<string, string[]>();
    for (const { albumId, userId } of owners) {
      const own = byAlbum.get(albumId) ?? [];
      own.push(userId);
      byAlbum.set(albumId, own);
    }
    for (const row of rows) {
      const own = byAlbum.get(row.id) ?? [];
      if (own.length !== 1) {
        throw new Error('Buddy restore album unavailable');
      }
      result.set(row.id, {
        deleted: !!row.deletedAt,
        album: {
          ownerId: own[0],
          name: row.albumName,
          description: row.description ?? '',
          coverAssetId: row.albumThumbnailAssetId,
          order: row.order as BuddyAlbum['order'],
          sharedUsers: [],
          parentId: row.parentId,
          kind: row.kind as BuddyAlbum['kind'],
          icon: row.icon,
          sortOrder: row.sortOrder,
        },
      });
    }
    return result;
  }
  async capture(
    pairs: Array<{
      ownerId: string;
      personId: string;
    }>,
  ): Promise<BuddyMetadata> {
    const metadata: BuddyMetadata = { version: 1, peopleByOwner: {}, albums: {} };
    const wanted = new Set(pairs.map(({ ownerId, personId }) => `${ownerId}:${personId}`));
    const groups = [...new Set(pairs.map(({ personId }) => personId))];
    if (groups.length > 0) {
      const people = await this.db
        .selectFrom('person')
        .innerJoin('user', 'user.id', 'person.ownerId')
        .select([
          'person.ownerId',
          'person.personGroupId',
          'person.name',
          'person.birthDate',
          'person.isHidden',
          'person.isFavorite',
        ])
        .where('person.personGroupId', '=', sql<string>`any(${groups}::uuid[])`)
        .where('user.deletedAt', 'is', null)
        .execute();
      for (const person of people) {
        if (!wanted.has(`${person.ownerId}:${person.personGroupId}`)) {
          continue;
        }
        metadata.peopleByOwner[person.ownerId] ??= {};
        metadata.peopleByOwner[person.ownerId][person.personGroupId] = {
          ownerId: person.ownerId,
          name: person.name,
          birthDate: person.birthDate
            ? new Date(person.birthDate as unknown as string).toISOString().slice(0, 10)
            : null,
          isHidden: person.isHidden,
          isFavorite: person.isFavorite,
        };
      }
    }
    const users = await this.db.selectFrom('user').select('id').where('deletedAt', 'is', null).execute();
    const liveOwners = new Set(users.map(({ id }) => id));
    for (const [id, { album, deleted }] of await this.albums(undefined, false, true)) {
      if (!deleted && liveOwners.has(album.ownerId)) {
        metadata.albums[id] = album;
      }
    }
    return readBuddyMetadata(metadata)!;
  }
  async visibleAlbumIds(metadata: BuddyMetadata, ownerId: string): Promise<Set<string>> {
    const ids = Object.keys(metadata.albums).filter((id) => metadata.albums[id].ownerId === ownerId);
    const current = await this.albums(ids);
    return new Set(
      ids.filter((id) => !current.has(id) || (!current.get(id)!.deleted && current.get(id)!.album.ownerId === ownerId)),
    );
  }
  async plan(metadata: BuddyMetadata, ids: string[], mode: 'keep' | 'replace'): Promise<BuddyAlbumPlan> {
    const plan: BuddyAlbumPlan = { version: 1, albums: {} };
    const current = await this.albums(ids);
    for (const id of ids) {
      const backup = metadata.albums[id];
      const row = current.get(id);
      if (
        !backup ||
        (backup.icon !== null && !isValidAlbumIcon(backup.icon)) ||
        (row && (row.deleted || row.album.ownerId !== backup.ownerId || row.album.kind !== backup.kind))
      ) {
        throw new Error('Buddy restore album unavailable');
      }
      plan.albums[id] = { before: row?.album ?? null, after: row && mode === 'keep' ? row.album : backup };
    }
    for (const { after } of Object.values(plan.albums)) {
      await this.parent(after, plan, false);
    }
    return plan;
  }
  private async parent(album: BuddyAlbum, plan: BuddyAlbumPlan, lock: boolean) {
    if (!album.parentId) {
      return;
    }
    if (album.kind !== 'album') {
      throw new Error('Buddy restore parent unavailable');
    }
    const parent = plan.albums[album.parentId]?.after;
    if (parent && parent.ownerId === album.ownerId && parent.kind === 'collection') {
      return;
    }
    const current = (await this.albums([album.parentId], lock)).get(album.parentId);
    let grantQuery = this.db
      .selectFrom('album_user')
      .select('userId')
      .where('albumId', '=', album.parentId)
      .where('userId', '=', album.ownerId)
      .where('role', 'in', [AlbumUserRole.Owner, AlbumUserRole.Editor]);
    if (lock) {
      grantQuery = grantQuery.forShare().noWait();
    }
    const grant = await grantQuery.executeTakeFirst();
    if (!current || current.deleted || current.album.kind !== 'collection' || !grant) {
      throw new Error('Buddy restore parent unavailable');
    }
  }
  /** Never copy divergent public hierarchy or identity over the authoritative fork representation. */
  private async assertLegacyStructure(id: string, current: BuddyAlbum) {
    const album = await this.db
      .selectFrom('album')
      .select(['parentId', 'kind'])
      .where('id', '=', id)
      .forShare()
      .noWait()
      .executeTakeFirstOrThrow();
    if (album.parentId !== current.parentId || album.kind !== current.kind)
      throw new Error('Buddy restore album representation unavailable');
  }
  /** Runs only under withRestore's current session/claim guard. No historical ACL or foreign membership is inserted. */
  async publish(plan: BuddyAlbumPlan, actorId: string, admin: boolean): Promise<void> {
    if (!this.db.isTransaction || plan.version !== 1) {
      throw new Error('Buddy metadata transaction required');
    }
    const trx = this.db as Transaction<DB>;
    const albums = new AlbumRepository(trx);
    const entries = Object.entries(plan.albums).sort(
      ([leftId, left], [rightId, right]) =>
        Number(left.after.kind === 'album') - Number(right.after.kind === 'album') || leftId.localeCompare(rightId),
    );
    for (const [id, { before, after }] of entries) {
      if (!admin && after.ownerId !== actorId) {
        throw new Error('Buddy restore album unavailable');
      }
      await trx
        .selectFrom('user')
        .select('id')
        .where('id', '=', after.ownerId)
        .where('deletedAt', 'is', null)
        .forShare()
        .noWait()
        .executeTakeFirstOrThrow();
      const row = (await this.albums([id], true)).get(id);
      if (row && (row.deleted || row.album.ownerId !== after.ownerId || row.album.kind !== after.kind)) {
        throw new Error('Buddy restore album unavailable');
      }
      const changed = row
        ? buddyAlbumState(row.album) !== buddyAlbumState(after) &&
          (!before || buddyAlbumState(row.album) !== buddyAlbumState(before))
        : !!before;
      if (changed) {
        throw new Error('Buddy restore album changed');
      }
      if (row) {
        await this.assertLegacyStructure(id, row.album);
      }
      if (row) {
        await trx
          .updateTable('album')
          .set({
            albumName: after.name,
            description: after.description,
            order: after.order as AssetOrder,
            icon: after.icon,
            sortOrder: after.sortOrder,
          })
          .where('id', '=', id)
          .execute();
      } else {
        await albums.create(
          {
            id,
            albumName: after.name,
            description: after.description,
            order: after.order as AssetOrder,
            kind: after.kind as AlbumKind,
            parentId: null,
            icon: after.icon,
            sortOrder: after.sortOrder,
            albumThumbnailAssetId: null,
          },
          [],
          [{ userId: after.ownerId, role: AlbumUserRole.Owner }],
          after.ownerId,
        );
      }
      await this.parent(after, plan, true);
      const parentId = row?.album.parentId ?? null;
      if (parentId !== after.parentId) {
        await albums.reparentIn(trx, id, after.parentId, parentId);
      }
    }
  }
  /** Buddy metadata has its own authenticated source manifest and does not need an asset anchor. */
  async withRestore<T>(
    owner: {
      ownerId: string;
      sessionId: string;
    },
    lease: {
      operationId: string;
      claimToken: string;
    },
    admin: boolean,
    authorize: () => Promise<void>,
    action: (trx: Transaction<DB>) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction().execute(async (trx) => {
      const operation = await trx
        .selectFrom('media_operation')
        .select('id')
        .where('id', '=', lease.operationId)
        .where('ownerId', '=', owner.ownerId)
        .where('kind', '=', MediaOperationKind.BuddyRestore)
        .where('claimToken', '=', lease.claimToken)
        .where('status', '=', MediaOperationStatus.Rendering)
        .where('claimExpiresAt', '>', sql<Date>`clock_timestamp()`)
        .where('cancelRequestedAt', 'is', null)
        .where('pauseRequestedAt', 'is', null)
        .forShare()
        .noWait()
        .executeTakeFirst();
      const session = await trx
        .selectFrom('session')
        .select('id')
        .where('id', '=', owner.sessionId)
        .where('userId', '=', owner.ownerId)
        .where('pinExpiresAt', '>', sql<Date>`clock_timestamp()`)
        .where((eb) => eb.or([eb('expiresAt', 'is', null), eb('expiresAt', '>', sql<Date>`clock_timestamp()`)]))
        .forShare()
        .noWait()
        .executeTakeFirst();
      let userQuery = trx
        .selectFrom('user')
        .select('id')
        .where('id', '=', owner.ownerId)
        .where('deletedAt', 'is', null);
      if (admin) {
        userQuery = userQuery.where('isAdmin', '=', true);
      }
      const user = await userQuery.forShare().noWait().executeTakeFirst();
      if (!operation || !session || !user) {
        throw new Error('Buddy restore metadata authority unavailable');
      }
      await authorize();
      return action(trx);
    });
  }
}
