import { BadRequestException, Injectable } from '@nestjs/common';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { AccessRepository } from 'src/repositories/access.repository.js';
import type { AssetRepository } from 'src/repositories/asset.repository.js';
import type { ArgOf } from 'src/repositories/event.repository.js';
import type { ItemShareRepository, ItemShareRow } from 'src/repositories/item-share.repository.js';
import type { UserRepository } from 'src/repositories/user.repository.js';
import { OnEvent } from 'src/decorators.js';
import { mapAsset } from 'src/dtos/asset-response.dto.js';
import {
  ItemShareChangeDto,
  ItemShareChangeResponseDto,
  ItemShareQueryDto,
  ItemShareReceivedResponseDto,
  ItemShareResponseDto,
} from 'src/dtos/item-share.dto.js';
import { UserResponseDto, mapUser } from 'src/dtos/user.dto.js';
import { AssetVisibility } from 'src/enum.js';
import { BaseService } from 'src/services/base.service.js';
import { getHiddenContentQueryOptions } from 'src/utils/hidden-content.js';
import { resolveShareBaseUrl } from 'src/utils/public-url.js';

/** Where a recipient opens what was shared with them: the Sharing page's "Shared with you" section. */
export const SHARED_WITH_YOU_PATH = '/sharing?section=shared-with-you';

/** Why a share was refused: an item is locked, or hidden by one of the owner's Locked rules. */
export const ITEM_SHARE_LOCKED = 'Locked items cannot be shared. Unlock them first.';
/** Hidden items cannot be shared directly, including Live Photo motion assets. */
export const ITEM_SHARE_HIDDEN = 'Hidden items cannot be shared. Unhide them first.';

/**
 * Sharing individual items with people in this library (FL-83 AL-30b, owner decision 2026-09-27),
 * the prototype's "Share with people in this library" (`SharedLinks.jsx:425-590`, `App.jsx:3876-3893`).
 *
 * - Only the owner shares an item, and only with other people who have an account here. It is not
 *   partner sharing: nothing but the chosen items is reachable, and nothing leaves the server.
 * - Locked items are never shared (the prototype refuses "Unmark Sensitive before sharing this
 *   item"): a share naming an item that is locked, or hidden by one of the owner's Locked rules, is
 *   refused as a whole. An item locked after it was shared disappears for the recipient, from their
 *   list and from every read, until it is unlocked (`ItemShareRepository`, `checkItemShareAccess`).
 * - Hidden items are refused and stay out of recipient reads, including shares made before hiding.
 * - New recipients get the notification album invitations use: an in-app notification and, when
 *   they allow album invitation emails, an email; both carry the link.
 * - The link is `resolveShareBaseUrl`: the Public server URL, else the direct-connection address or
 *   the custom hostname, never an unverified Host header.
 */
@Injectable()
export class ItemShareService extends BaseService {
  @OnEvent({ name: 'AssetHide' })
  async onAssetHide({ assetId }: ArgOf<'AssetHide'>): Promise<void> {
    await this.onAssetLocked({ assetIds: [assetId] });
  }

  @OnEvent({ name: 'AssetLocked' })
  async onAssetLocked({ assetIds }: ArgOf<'AssetLocked'>): Promise<void> {
    let recipients;
    try {
      recipients = await this.itemShareRepository.getRecipients(assetIds);
    } catch (error) {
      this.logger.warn(`Could not notify item-share recipients after hiding ${assetIds.join(', ')}: ${error}`);
      return;
    }

    for (const { assetId, sharedWithId } of recipients) {
      try {
        this.websocketRepository.clientSend('on_asset_hidden', sharedWithId, assetId);
      } catch (error) {
        this.logger.warn(`Could not notify item-share recipient ${sharedWithId} after hiding ${assetId}: ${error}`);
      }
    }
  }

  async share(auth: AuthDto, dto: ItemShareChangeDto, requestOrigin?: string): Promise<ItemShareChangeResponseDto> {
    const assetIds = [...new Set(dto.assetIds)];
    const recipients = await this.requireRecipients(auth, dto.userIds);

    const link = await this.shareLink(requestOrigin);
    const { added, response } = await this.itemShareRepository.withTransaction(
      async (shares, users, assets, access) => {
        await this.requireShareableItems(auth, assetIds, assets, access);
        const added = await shares.add(auth.user.id, assetIds, recipients.keys().toArray());
        const response = await this.changeResponse(
          auth,
          assetIds,
          { added: added.length, removed: 0, link },
          shares,
          users,
        );
        return { added, response };
      },
      assetIds,
    );

    const counts = new Map<string, number>();
    for (const row of added) {
      counts.set(row.sharedWithId, (counts.get(row.sharedWithId) ?? 0) + 1);
    }
    for (const [userId, count] of counts) {
      try {
        await this.eventRepository.emit('ItemShare', {
          ownerId: auth.user.id,
          userId,
          senderName: auth.user.name,
          count,
          link: link ?? null,
        });
      } catch (error) {
        this.logger.warn(`Could not notify item-share recipient ${userId} after sharing: ${error}`);
      }
    }

    return response;
  }

  async unshare(auth: AuthDto, dto: ItemShareChangeDto, requestOrigin?: string): Promise<ItemShareChangeResponseDto> {
    const assetIds = await this.requireOwnItems(auth, dto.assetIds);
    const link = await this.shareLink(requestOrigin);
    const { removed, response } = await this.itemShareRepository.withTransaction(async (shares, users) => {
      const removed = await shares.remove(auth.user.id, assetIds, dto.userIds);
      const response = await this.changeResponse(
        auth,
        assetIds,
        { added: 0, removed: removed.length, link },
        shares,
        users,
      );
      return { removed, response };
    });
    // Access is checked live, so this only tells the recipients' open pages to drop what they loaded.
    for (const row of removed) {
      try {
        this.websocketRepository.clientSend('on_asset_hidden', row.sharedWithId, row.assetId);
      } catch (error) {
        this.logger.warn(
          `Could not notify item-share recipient ${row.sharedWithId} after revoking ${row.assetId}: ${error}`,
        );
      }
    }
    return response;
  }

  async getShares(auth: AuthDto, dto: ItemShareQueryDto): Promise<ItemShareResponseDto[]> {
    const assetIds = await this.requireOwnItems(auth, dto.assetIds);
    return this.mapShares(await this.itemShareRepository.getForAssets(auth.user.id, assetIds));
  }

  async getReceived(auth: AuthDto, requestOrigin?: string): Promise<ItemShareReceivedResponseDto> {
    const rows = await this.itemShareRepository.getReceived(auth.user.id);
    const link = await this.shareLink(requestOrigin);
    if (rows.length === 0) {
      return { items: [], link };
    }

    // The recipient's own privacy settings (their hidden content) apply as to anything they see.
    const assetIds = [...new Set(rows.map(({ assetId }) => assetId))];
    const hidden = await this.assetRepository.getHiddenContentAssetIds(assetIds, getHiddenContentQueryOptions(auth));
    const assets = new Map(
      (await this.assetRepository.getByIds(assetIds.filter((id) => !hidden.has(id)))).map((asset) => [asset.id, asset]),
    );
    const owners = await this.usersById([...new Set(rows.map(({ ownerId }) => ownerId))]);

    const items = [];
    for (const row of rows) {
      const asset = assets.get(row.assetId);
      const owner = owners.get(row.ownerId);
      if (!asset || !owner || asset.isLocked || asset.visibility === AssetVisibility.Hidden || asset.deletedAt) {
        continue;
      }
      items.push({
        id: row.id,
        sharedAt: new Date(row.createdAt).toISOString(),
        owner,
        asset: mapAsset(asset, { auth }),
      });
    }
    return { items, link };
  }

  /** The owner's own items, all of them, or the request is refused. */
  private async requireOwnItems(auth: AuthDto, ids: string[], access = this.accessRepository): Promise<string[]> {
    const assetIds = [...new Set(ids)];
    const owned = await access.asset.checkOwnerAccess(
      auth.user.id,
      new Set(assetIds),
      auth.session?.hasElevatedPermission,
    );
    if (owned.size !== assetIds.length) {
      throw new BadRequestException('Only your own items can be shared with people');
    }
    return assetIds;
  }

  private async requireShareableItems(
    auth: AuthDto,
    ids: string[],
    repository: AssetRepository,
    access: AccessRepository,
  ): Promise<string[]> {
    const assetIds = await this.requireOwnItems(auth, ids, access);
    const assets = await repository.getByIds(assetIds);
    if (assets.some(({ visibility }) => visibility === AssetVisibility.Hidden)) {
      throw new BadRequestException(ITEM_SHARE_HIDDEN);
    }
    const locked = await repository.getLockedAssetIds(assetIds);
    const suppressed = auth.suppressedContent
      ? await repository.getHiddenContentAssetIds(assetIds, { hiddenContent: auth.suppressedContent })
      : new Set<string>();
    if (locked.size > 0 || suppressed.size > 0) {
      throw new BadRequestException(ITEM_SHARE_LOCKED);
    }
    return assetIds;
  }

  /** Other people with an account here; yourself, unknown and deleted accounts are refused. */
  private async requireRecipients(auth: AuthDto, ids: string[]): Promise<Map<string, UserResponseDto>> {
    const userIds = [...new Set(ids)];
    if (userIds.includes(auth.user.id)) {
      throw new BadRequestException('You cannot share items with yourself');
    }
    const users = await this.usersById(userIds);
    if (users.size !== userIds.length) {
      throw new BadRequestException('Share with people who have an account on this server');
    }
    return users;
  }

  private async usersById(ids: string[], repository = this.userRepository): Promise<Map<string, UserResponseDto>> {
    const users = new Map<string, UserResponseDto>();
    for (const id of ids) {
      const user = await repository.get(id, { withDeleted: false });
      if (user) {
        users.set(user.id, mapUser(user));
      }
    }
    return users;
  }

  private async mapShares(rows: ItemShareRow[], repository = this.userRepository): Promise<ItemShareResponseDto[]> {
    const users = await this.usersById([...new Set(rows.map(({ sharedWithId }) => sharedWithId))], repository);
    return rows.flatMap((row) => {
      const sharedWith = users.get(row.sharedWithId);
      return sharedWith
        ? [{ id: row.id, assetId: row.assetId, sharedWith, createdAt: new Date(row.createdAt).toISOString() }]
        : [];
    });
  }

  private async changeResponse(
    auth: AuthDto,
    assetIds: string[],
    change: { added: number; removed: number; link: string | null },
    repository: ItemShareRepository,
    users: UserRepository,
  ): Promise<ItemShareChangeResponseDto> {
    const shares = await this.mapShares(await repository.getForAssets(auth.user.id, assetIds), users);
    return { shares, ...change };
  }

  /** The "Shared with you" address on this server, or null when it has no address to give out. */
  async shareLink(requestOrigin?: string | null): Promise<string | null> {
    const { server, frameleafCloud } = await this.getConfig({ withCache: true });
    const base = await resolveShareBaseUrl(
      server,
      { configRepository: this.configRepository, systemMetadataRepository: this.systemMetadataRepository },
      frameleafCloud.remoteAccess,
      requestOrigin,
    );
    return base ? `${base}${SHARED_WITH_YOU_PATH}` : null;
  }
}
