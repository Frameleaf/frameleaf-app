import { BadRequestException, Injectable } from '@nestjs/common';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { BulkIdsDto } from 'src/dtos/asset-ids.response.dto.js';
import { StackCreateDto, StackResponseDto, StackSearchDto, StackUpdateDto, mapStack } from 'src/dtos/stack.dto.js';
import { Permission } from 'src/enum.js';
import { BaseService } from 'src/services/base.service.js';
import { type HiddenContentQueryOptions, getHiddenContentQueryOptions } from 'src/utils/hidden-content.js';
import { type LockedVisibilityOptions, getLockedVisibilityOptions } from 'src/utils/locked-visibility.js';
import { findOrFail } from 'src/utils/misc.js';
import { UUIDAssetIDParamDto } from 'src/validation.js';

@Injectable()
export class StackService extends BaseService {
  async search(auth: AuthDto, dto: StackSearchDto): Promise<StackResponseDto[]> {
    const options = this.nsfwOptions(auth);
    const query = {
      ownerId: auth.user.id,
      primaryAssetId: dto.primaryAssetId,
      ...options,
      // a stack led by Locked media, and its Locked members, only for the owner's elevated session
      ...getLockedVisibilityOptions(auth),
    };
    const stacks = await this.stackRepository.search(query);

    return stacks.map((stack) => mapStack(stack, { auth }));
  }

  async create(auth: AuthDto, dto: StackCreateDto): Promise<StackResponseDto> {
    await this.requireAccess({ auth, permission: Permission.AssetUpdate, ids: dto.assetIds });

    const stack = await this.stackRepository.create({ ownerId: auth.user.id }, dto.assetIds);
    // a stack that holds a Locked photo became Locked as a whole (FL-53)
    if (stack.lockedAssetIds.length > 0) {
      await this.afterAssetsLocked(stack.lockedAssetIds);
      // push a real-time update for every asset the new stack carried into the Locked folder, so an
      // open web client reflects the whole stack at once, not only the photo that was already Locked
      await this.notifyAssetsUpdated(stack.lockedAssetIds, auth.user.id);
    }

    await this.eventRepository.emit('StackCreate', { stackId: stack.id, userId: auth.user.id });

    return mapStack(stack, { auth });
  }

  async get(auth: AuthDto, id: string): Promise<StackResponseDto> {
    await this.requireAccess({ auth, permission: Permission.StackRead, ids: [id] });
    const stack = await this.findOrFail(id, this.readOptions(auth));
    return mapStack(stack, { auth });
  }

  async update(auth: AuthDto, id: string, dto: StackUpdateDto): Promise<StackResponseDto> {
    await this.requireAccess({ auth, permission: Permission.StackUpdate, ids: [id] });
    const stack = await this.findOrFail(id, this.readOptions(auth));
    if (dto.primaryAssetId && stack.assets.every(({ id }) => id !== dto.primaryAssetId)) {
      throw new BadRequestException('Primary asset must be in the stack');
    }

    const options = this.readOptions(auth);
    const update = { id, primaryAssetId: dto.primaryAssetId };
    const updatedStack = options
      ? await this.stackRepository.update(id, update, options)
      : await this.stackRepository.update(id, update);

    await this.eventRepository.emit('StackUpdate', { stackId: id, userId: auth.user.id });

    return mapStack(updatedStack, { auth });
  }

  async delete(auth: AuthDto, id: string): Promise<void> {
    await this.requireAccess({ auth, permission: Permission.StackDelete, ids: [id] });
    await this.stackRepository.delete(id);
    await this.eventRepository.emit('StackDelete', { stackId: id, userId: auth.user.id });
  }

  async deleteAll(auth: AuthDto, dto: BulkIdsDto): Promise<void> {
    await this.requireAccess({ auth, permission: Permission.StackDelete, ids: dto.ids });
    await this.stackRepository.deleteAll(dto.ids);
    await this.eventRepository.emit('StackDeleteAll', { stackIds: dto.ids, userId: auth.user.id });
  }

  async removeAsset(auth: AuthDto, dto: UUIDAssetIDParamDto): Promise<void> {
    const { id: stackId, assetId } = dto;
    await this.requireAccess({ auth, permission: Permission.StackUpdate, ids: [stackId] });

    const stack = await this.stackRepository.getForAssetRemoval(assetId);

    if (!stack?.id || stack.id !== stackId) {
      throw new BadRequestException('Asset not in stack');
    }

    if (stack.primaryAssetId === assetId) {
      throw new BadRequestException("Cannot remove stack's primary asset");
    }

    await this.assetRepository.update({ id: assetId, stackId: null });
    await this.eventRepository.emit('StackUpdate', { stackId, userId: auth.user.id });
  }

  private findOrFail(id: string, options?: HiddenContentQueryOptions & LockedVisibilityOptions) {
    return findOrFail(
      () => (options ? this.stackRepository.getById(id, options) : this.stackRepository.getById(id)),
      'Asset stack',
    );
  }

  private nsfwOptions(auth: AuthDto) {
    return auth.hideNsfwAssets ? getHiddenContentQueryOptions(auth) : undefined;
  }

  /** What a stack read may show this viewer: hidden-content settings, and their Locked media only when elevated. */
  private readOptions(auth: AuthDto): (HiddenContentQueryOptions & LockedVisibilityOptions) | undefined {
    const options = { ...this.nsfwOptions(auth), ...getLockedVisibilityOptions(auth) };
    return Object.keys(options).length > 0 ? options : undefined;
  }
}
