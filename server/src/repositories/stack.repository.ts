import { BadRequestException, ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { type ExpressionBuilder, type Insertable, type Kysely, type Transaction, type Updateable } from 'kysely';
import { jsonArrayFrom } from 'kysely/helpers/postgres';
import { InjectKysely } from 'nestjs-kysely';
import { randomUUID } from 'node:crypto';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { HiddenContentQueryOptions } from 'src/utils/hidden-content.js';
import type { LockedVisibilityOptions } from 'src/utils/locked-visibility.js';
import { columns } from 'src/database.js';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { AssetStatus } from 'src/enum.js';
import { AssetLocalEffectRepository } from 'src/repositories/asset-local-effect.repository.js';
import { currentAuth } from 'src/repositories/icloud-audit.repository.js';
import {
  associatedSeeds,
  requireEditFamilyCoverage,
  withEditFamilyTransaction,
} from 'src/repositories/icloud-edit-transaction.js';
import { DB } from 'src/schema/index.js';
import { StackTable } from 'src/schema/tables/stack.table.js';
import {
  asUuid,
  getHiddenContentFilter,
  hasHiddenLockedPrimary,
  isMotionOfLockedStill,
  withAlbumVisibility,
  withHiddenContentFilter,
} from 'src/utils/database.js';
import { getHiddenContentQueryOptions } from 'src/utils/hidden-content.js';
import { onStacksJoined } from 'src/utils/locked-stacks.js';
import { isLocked, isNotLocked } from 'src/utils/locked.js';

export interface StackSearch extends HiddenContentQueryOptions, LockedVisibilityOptions {
  ownerId: string;
  primaryAssetId?: string;
}

/**
 * `lockedOwnerId`: the viewer, when their session is elevated. Only then are their own Locked
 * members listed, and only then is a stack whose primary is Locked returned at all (FL-34).
 */
type StackPrivacyOptions = HiddenContentQueryOptions & LockedVisibilityOptions;

const withAssets = (eb: ExpressionBuilder<DB, 'stack'>, withTags = false, options: StackPrivacyOptions = {}) => {
  return jsonArrayFrom(
    eb
      .selectFrom('asset')
      .selectAll('asset')
      // FL-34: the lock, so a response reports `locked` and `mapStack` can leave it out
      .select(isLocked('asset').as('isLocked'))
      .innerJoinLateral(
        (eb) =>
          eb
            .selectFrom('asset_exif')
            .select(columns.exif)
            .whereRef('asset_exif.assetId', '=', 'asset.id')
            .as('exifInfo'),
        (join) => join.onTrue(),
      )
      .$if(withTags, (eb) =>
        eb.select((eb) =>
          jsonArrayFrom(
            eb
              .selectFrom('tag')
              .select(columns.tag)
              .innerJoin('tag_asset', 'tag.id', 'tag_asset.tagId')
              .whereRef('tag_asset.assetId', '=', 'asset.id'),
          ).as('tags'),
        ),
      )
      .select((eb) => eb.fn.toJson('exifInfo').as('exifInfo'))
      .where('asset.deletedAt', 'is', null)
      .whereRef('asset.stackId', '=', 'stack.id')
      .$call((qb) => withAlbumVisibility(qb, options.lockedOwnerId))
      .$call((qb) => withHiddenContentFilter(qb, options))
      .orderBy('asset.fileCreatedAt', 'asc'),
  ).as('assets');
};

@Injectable()
export class StackRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  /** Complete associated family prefix, shared by ordinary manual writes and policy publication. */
  private async authorityWrite<T>(
    ownerId: string,
    assetIds: string[],
    stackIds: string[],
    write: (tx: Transaction<DB>) => Promise<T>,
    auth?: AuthDto,
    capture?: (sequenced: boolean) => void,
    locks?: () => string[],
  ): Promise<T> {
    const priorMembers =
      stackIds.length > 0
        ? await this.db
            .selectFrom('asset')
            .select('id')
            .where('ownerId', '=', ownerId)
            .where('stackId', 'in', stackIds)
            .execute()
        : [];
    const selected = [...new Set([...assetIds, ...priorMembers.map((row) => row.id)])].sort();
    const hint = await associatedSeeds(this.db, ownerId, selected);
    const committed = await withEditFamilyTransaction(
      this.db,
      ownerId,
      { items: hint.items, assetIds: selected },
      async (tx) => {
        const binding = requireEditFamilyCoverage(tx, { items: hint.items, assetIds: selected }, false);
        const locked = binding.family.assetIds;
        if (locked.length > 0)
          await tx.selectFrom('asset').select('id').where('id', 'in', locked).orderBy('id').forUpdate().execute();
        const fresh = await associatedSeeds(tx, ownerId, locked);
        requireEditFamilyCoverage(tx, fresh, false);
        const liveStacks =
          stackIds.length > 0
            ? await tx
                .selectFrom('stack')
                .select(['id', 'ownerId'])
                .where('id', 'in', stackIds)
                .orderBy('id')
                .forUpdate()
                .execute()
            : [];
        if (liveStacks.some((row) => row.ownerId !== ownerId) || liveStacks.length !== stackIds.length)
          throw new ConflictException('edit_manual_stack_conflict');
        const currentMembers =
          stackIds.length > 0
            ? await tx.selectFrom('asset').select('id').where('stackId', 'in', stackIds).execute()
            : [];
        requireEditFamilyCoverage(tx, { items: fresh.items, assetIds: currentMembers.map((row) => row.id) }, false);
        const sequenced = fresh.items.length > 0;
        const verify = async () => {
          // Owner/status proof applies to every manual write, including a selection
          // without an accepted edit ledger. Association does not grant foreign membership.
          const owned =
            locked.length > 0
              ? await tx
                  .selectFrom('asset')
                  .select('id')
                  .where('id', 'in', locked)
                  .where('ownerId', '=', ownerId)
                  .where('status', 'in', [AssetStatus.Active, AssetStatus.Trashed])
                  .execute()
              : [];
          if (owned.length !== locked.length) throw new ConflictException('edit_evidence_unavailable');
          if (!sequenced) return;
          if (!auth || auth.sharedLink || auth.user.id !== ownerId || !auth.session)
            throw new ForbiddenException('edit_owner_session_required');
          const live = await currentAuth(tx, ownerId, auth.session.id, false);
          if (!live) throw new ForbiddenException('edit_owner_session_required');
          const safe = await tx
            .selectFrom('asset')
            .select('asset.id')
            .where('asset.ownerId', '=', ownerId)
            .where('asset.id', 'in', locked)
            .where('asset.status', 'in', [AssetStatus.Active, AssetStatus.Trashed])
            .$if(!live.session?.hasElevatedPermission, (qb) =>
              qb.where(isNotLocked('asset')).where((eb) => eb.not(isMotionOfLockedStill(eb))),
            )
            .$call((qb) => withHiddenContentFilter(qb, getHiddenContentQueryOptions(live)))
            .execute();
          if (safe.length !== locked.length) throw new ConflictException('edit_evidence_unavailable');
        };
        await verify();
        if (
          sequenced &&
          locks &&
          (
            await tx
              .selectFrom('asset')
              .select('id')
              .where('id', 'in', locked)
              .where(isLocked('asset'))
              .limit(1)
              .execute()
          ).length > 0
        )
          await AssetLocalEffectRepository.refuseRelevantLegacyInteractive(tx, ownerId, locked);
        const value = await write(tx);
        if (sequenced) {
          const newlyLocked = locks?.() ?? [];
          requireEditFamilyCoverage(tx, { items: fresh.items, assetIds: newlyLocked }, false);
          const lockedCascade =
            newlyLocked.length > 0
              ? await AssetLocalEffectRepository.selectLockedAdmissions(tx, newlyLocked)
              : undefined;
          const rows = await tx
            .selectFrom('asset')
            .select(['id', 'status', 'stackId'])
            .where('id', 'in', locked)
            .orderBy('id')
            .execute();
          const ids = [...new Set(rows.flatMap((row) => (row.stackId ? [row.stackId] : [])))].sort();
          const stacks = [];
          for (const id of ids) {
            const stack = await tx
              .selectFrom('stack')
              .select(['id', 'primaryAssetId'])
              .where('id', '=', id)
              .where('ownerId', '=', ownerId)
              .executeTakeFirstOrThrow();
            const members = await tx.selectFrom('asset').select('id').where('stackId', '=', id).orderBy('id').execute();
            if (members.some((row) => !locked.includes(row.id))) throw new ConflictException('edit_family_unstable');
            stacks.push({
              stackId: id,
              primaryAssetId: stack.primaryAssetId,
              memberAssetIds: members.map((row) => row.id),
            });
          }
          await new AssetLocalEffectRepository(tx).append(tx, ownerId, randomUUID(), {
            origin: { kind: 'stack' },
            assets: rows.map((row) => ({
              assetId: row.id,
              status: row.status as AssetStatus.Active | AssetStatus.Trashed,
              revoke: false,
            })),
            stacks,
            ...(lockedCascade && { lockedCascade }),
          });
          await verify();
        }
        return { value, sequenced };
      },
    );
    capture?.(committed.sequenced);
    return committed.value;
  }

  async enqueueLocalEffects() {
    return new AssetLocalEffectRepository(this.db).enqueuePending();
  }

  @GenerateSql({ params: [{ ownerId: DummyValue.UUID, excludeNsfw: true }] })
  search(query: StackSearch) {
    return this.db
      .selectFrom('stack')
      .selectAll('stack')
      .select((eb) => withAssets(eb, false, query))
      .where('stack.ownerId', '=', query.ownerId)
      .where((eb) => eb.not(hasHiddenLockedPrimary(eb, query.lockedOwnerId)))
      .$if(!!query.primaryAssetId, (eb) => eb.where('stack.primaryAssetId', '=', query.primaryAssetId!))
      .$if(!!getHiddenContentFilter(query), (qb) =>
        qb
          .innerJoin('asset as primaryAsset', 'primaryAsset.id', 'stack.primaryAssetId')
          .where('primaryAsset.deletedAt', 'is', null)
          .$call((qb) => withHiddenContentFilter(qb, query, 'primaryAsset')),
      )
      .execute();
  }

  async create(
    entity: Omit<Insertable<StackTable>, 'primaryAssetId'>,
    assetIds: string[],
    auth?: AuthDto,
    capture?: (sequenced: boolean) => void,
  ) {
    let joinedLocks: string[] = [];
    return this.authorityWrite(
      entity.ownerId,
      assetIds,
      [],
      async (tx) => {
        const stacks = await tx
          .selectFrom('stack')
          .where('stack.ownerId', '=', entity.ownerId)
          .where('stack.primaryAssetId', 'in', assetIds)
          .select('stack.id')
          .select((eb) =>
            jsonArrayFrom(
              eb
                .selectFrom('asset')
                .select('asset.id')
                .whereRef('asset.stackId', '=', 'stack.id')
                .where('asset.deletedAt', 'is', null),
            ).as('assets'),
          )
          .execute();

        const uniqueIds = new Set<string>(assetIds);

        // children
        for (const stack of stacks) {
          if (stack.assets && stack.assets.length > 0) {
            for (const asset of stack.assets) {
              uniqueIds.add(asset.id);
            }
          }
        }

        if (stacks.length > 0) {
          await tx
            .deleteFrom('stack')
            .where(
              'id',
              'in',
              stacks.map((stack) => stack.id),
            )
            .execute();
        }

        const newRecord = await tx
          .insertInto('stack')
          .values({ ...entity, primaryAssetId: assetIds[0] })
          .returning('id')
          .executeTakeFirstOrThrow();

        await tx
          .updateTable('asset')
          .set({
            stackId: newRecord.id,
            updatedAt: new Date(),
          })
          .where('id', 'in', [...uniqueIds])
          .execute();

        // a stack that holds a Locked photo is Locked as a whole (FL-53)
        const lockedAssetIds = await onStacksJoined(tx, [newRecord.id]);
        joinedLocks = lockedAssetIds;

        const stack = await tx
          .selectFrom('stack')
          .selectAll('stack')
          .select(withAssets)
          .where('id', '=', newRecord.id)
          .executeTakeFirstOrThrow();

        // the photos that became Locked by joining it, for the caller's follow-up
        return { ...stack, lockedAssetIds };
      },
      auth,
      capture,
      () => joinedLocks,
    );
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async delete(id: string, auth?: AuthDto, capture?: (sequenced: boolean) => void): Promise<void> {
    await this.deleteAll([id], auth, capture);
  }

  async deleteAll(ids: string[], auth?: AuthDto, capture?: (sequenced: boolean) => void): Promise<void> {
    if (ids.length === 0) return;
    const rows = await this.db.selectFrom('stack').select(['id', 'ownerId']).where('id', 'in', ids).execute();
    if (rows.length === 0) {
      capture?.(false);
      return;
    }
    const owners = [...new Set(rows.map((row) => row.ownerId))];
    if (owners.length !== 1) throw new ConflictException('edit_manual_stack_conflict');
    await this.authorityWrite(
      owners[0],
      [],
      rows.map((row) => row.id).sort(),
      async (tx) => {
        await tx.deleteFrom('stack').where('id', 'in', ids).execute();
      },
      auth,
      capture,
    );
  }

  async update(
    id: string,
    entity: Updateable<StackTable>,
    options: StackPrivacyOptions = {},
    auth?: AuthDto,
    capture?: (sequenced: boolean) => void,
  ) {
    const prior = await this.db
      .selectFrom('stack')
      .select('ownerId')
      .where('id', '=', asUuid(id))
      .executeTakeFirstOrThrow();
    return this.authorityWrite(
      prior.ownerId,
      [],
      [id],
      async (tx) => {
        if (entity.primaryAssetId) {
          const member = await tx
            .selectFrom('asset')
            .select('id')
            .where('id', '=', entity.primaryAssetId)
            .where('stackId', '=', id)
            .executeTakeFirst();
          if (!member) throw new BadRequestException('Primary asset must be in the stack');
        }
        return tx
          .updateTable('stack')
          .set(entity)
          .where('id', '=', asUuid(id))
          .returningAll('stack')
          .returning((eb) => withAssets(eb, true, options))
          .executeTakeFirstOrThrow();
      },
      auth,
      capture,
    );
  }

  async removeMember(stackId: string, assetId: string, auth: AuthDto, capture?: (sequenced: boolean) => void) {
    return this.authorityWrite(
      auth.user.id,
      [assetId],
      [stackId],
      async (tx) => {
        const stack = await tx
          .selectFrom('stack')
          .select('primaryAssetId')
          .where('id', '=', stackId)
          .executeTakeFirstOrThrow();
        const member = await tx
          .selectFrom('asset')
          .select('stackId')
          .where('id', '=', assetId)
          .executeTakeFirstOrThrow();
        if (member.stackId !== stackId || stack.primaryAssetId === assetId)
          throw new BadRequestException('Asset cannot be removed from stack');
        await tx.updateTable('asset').set({ stackId: null }).where('id', '=', assetId).execute();
      },
      auth,
      capture,
    );
  }

  @GenerateSql({ params: [DummyValue.UUID, { excludeNsfw: true }] })
  getById(id: string, options: StackPrivacyOptions = {}) {
    return this.db
      .selectFrom('stack')
      .selectAll()
      .select((eb) => withAssets(eb, true, options))
      .where('id', '=', asUuid(id))
      .where((eb) => eb.not(hasHiddenLockedPrimary(eb, options.lockedOwnerId)))
      .$if(!!getHiddenContentFilter(options), (qb) =>
        qb
          .innerJoin('asset as primaryAsset', 'primaryAsset.id', 'stack.primaryAssetId')
          .where('primaryAsset.deletedAt', 'is', null)
          .$call((qb) => withHiddenContentFilter(qb, options, 'primaryAsset')),
      )
      .executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID] })
  getForAssetRemoval(assetId: string) {
    return this.db
      .selectFrom('asset')
      .leftJoin('stack', 'stack.id', 'asset.stackId')
      .select(['stackId as id', 'stack.primaryAssetId'])
      .where('asset.id', '=', assetId)
      .executeTakeFirst();
  }

  /** Ordinary copy joins both existing stack families and removes the merged source atomically. */
  async copyMembership(
    sourceAssetId: string,
    targetAssetId: string,
    auth: AuthDto,
    capture?: (sequenced: boolean) => void,
  ) {
    const rows = await this.db
      .selectFrom('asset')
      .select(['id', 'stackId'])
      .where('ownerId', '=', auth.user.id)
      .where('id', 'in', [sourceAssetId, targetAssetId])
      .execute();
    const source = rows.find((row) => row.id === sourceAssetId),
      target = rows.find((row) => row.id === targetAssetId);
    if (!source || !target) throw new BadRequestException('Asset not found');
    if (!source.stackId || source.stackId === target.stackId) {
      capture?.(false);
      return;
    }
    let joinedLocks: string[] = [];
    const sourceStackId = source.stackId;
    const ids = [...new Set([sourceStackId, ...(target.stackId ? [target.stackId] : [])])].sort();
    await this.authorityWrite(
      auth.user.id,
      [sourceAssetId, targetAssetId],
      ids,
      async (tx) => {
        const actual = await tx
          .selectFrom('asset')
          .select(['id', 'stackId'])
          .where('id', 'in', [sourceAssetId, targetAssetId])
          .execute();
        if (
          actual.find((row) => row.id === sourceAssetId)?.stackId !== source.stackId ||
          actual.find((row) => row.id === targetAssetId)?.stackId !== target.stackId
        )
          throw new ConflictException('edit_manual_stack_conflict');
        if (target.stackId) {
          await tx.updateTable('asset').set({ stackId: target.stackId }).where('stackId', '=', sourceStackId).execute();
          joinedLocks = await onStacksJoined(tx, [target.stackId]);
          await tx.deleteFrom('stack').where('id', '=', sourceStackId).execute();
        } else {
          await tx.updateTable('asset').set({ stackId: source.stackId }).where('id', '=', targetAssetId).execute();
          joinedLocks = await onStacksJoined(tx, [sourceStackId]);
        }
      },
      auth,
      capture,
      () => joinedLocks,
    );
  }

  @GenerateSql({ params: [{ sourceId: DummyValue.UUID, targetId: DummyValue.UUID }] })
  async merge({ sourceId, targetId }: { sourceId: string; targetId: string }): Promise<void> {
    const source = await this.db
      .selectFrom('stack')
      .select('ownerId')
      .where('id', '=', sourceId)
      .executeTakeFirstOrThrow();
    await this.authorityWrite(source.ownerId, [], [sourceId, targetId].sort(), async (tx) => {
      await tx.updateTable('asset').set({ stackId: targetId }).where('stackId', '=', sourceId).execute();
      await onStacksJoined(tx, [targetId]);
    });
  }
}
