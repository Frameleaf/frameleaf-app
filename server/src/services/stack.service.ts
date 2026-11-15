import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { StackRepository } from 'src/repositories/stack.repository.js';
import type { JobOf } from 'src/types.js';
import { OnJob } from 'src/decorators.js';
import { BulkIdsDto } from 'src/dtos/asset-ids.response.dto.js';
import { StackCreateDto, StackResponseDto, StackSearchDto, StackUpdateDto, mapStack } from 'src/dtos/stack.dto.js';
import { JobName, JobStatus, Permission, QueueName } from 'src/enum.js';
import { BaseService } from 'src/services/base.service.js';
import { AUTO_STACK_VERSION, type CullFrame, groupBursts, pickBurstLead } from 'src/utils/assistant-action.js';
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

    let sequenced = false;
    const stack = await this.stackRepository.create({ ownerId: auth.user.id }, dto.assetIds, auth, (value) => {
      sequenced = value;
    });
    // a stack that holds a Locked photo became Locked as a whole (FL-53)
    if (stack.lockedAssetIds.length > 0) {
      await this.afterAssetsLocked(stack.lockedAssetIds, sequenced);
      // push a real-time update for every asset the new stack carried into the Locked folder, so an
      // open web client reflects the whole stack at once, not only the photo that was already Locked
      if (!sequenced) await this.notifyAssetsUpdated(stack.lockedAssetIds, auth.user.id);
    }

    if (sequenced) await this.stackRepository.enqueueLocalEffects();
    else await this.eventRepository.emit('StackCreate', { stackId: stack.id, userId: auth.user.id });

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
    let sequenced = false;
    const updatedStack = await this.stackRepository.update(id, update, options, auth, (value) => {
      sequenced = value;
    });
    if (sequenced) await this.stackRepository.enqueueLocalEffects();
    else await this.eventRepository.emit('StackUpdate', { stackId: id, userId: auth.user.id });

    return mapStack(updatedStack, { auth });
  }

  async delete(auth: AuthDto, id: string): Promise<void> {
    await this.requireAccess({ auth, permission: Permission.StackDelete, ids: [id] });
    // FL-953: what the owner unstacks is never stacked automatically again
    await this.stackRepository.excludeAutomaticMembers([id]);
    let sequenced = false;
    await this.stackRepository.delete(id, auth, (value) => {
      sequenced = value;
    });
    if (sequenced) await this.stackRepository.enqueueLocalEffects();
    else await this.eventRepository.emit('StackDelete', { stackId: id, userId: auth.user.id });
  }

  async deleteAll(auth: AuthDto, dto: BulkIdsDto): Promise<void> {
    await this.requireAccess({ auth, permission: Permission.StackDelete, ids: dto.ids });
    await this.stackRepository.excludeAutomaticMembers(dto.ids);
    let sequenced = false;
    await this.stackRepository.deleteAll(dto.ids, auth, (value) => {
      sequenced = value;
    });
    if (sequenced) await this.stackRepository.enqueueLocalEffects();
    else await this.eventRepository.emit('StackDeleteAll', { stackIds: dto.ids, userId: auth.user.id });
  }

  async unstackSelection(auth: AuthDto, stackIds: string[], assetIds: string[], elevated: boolean) {
    if (!auth.system || auth.sharedLink) throw new ForbiddenException('Bulk unstack requires the owner worker');
    await this.stackRepository.excludeAutomaticMembers(stackIds);
    let sequenced = false;
    const result = await this.stackRepository.unstackSelection(auth, stackIds, assetIds, elevated, (value) => {
      sequenced = value;
    });
    if (sequenced) await this.stackRepository.enqueueLocalEffects();
    else if (result.deletedStackIds.length > 0)
      await this.eventRepository.emit('StackDeleteAll', { stackIds: result.deletedStackIds, userId: auth.user.id });
    return result;
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

    await this.stackRepository.excludeFromAutomatic(stackId, assetId);
    let sequenced = false;
    await this.stackRepository.removeMember(stackId, assetId, auth, (value) => {
      sequenced = value;
    });
    if (sequenced) await this.stackRepository.enqueueLocalEffects();
    else await this.eventRepository.emit('StackUpdate', { stackId, userId: auth.user.id });
  }

  /** FL-953: every account whose bursts stack themselves gets a run (nightly, after the day's photos are scored). */
  @OnJob({ name: JobName.AutoStackQueueAll, queue: QueueName.BackgroundTask })
  async handleAutoStackQueueAll(): Promise<JobStatus> {
    const userIds = await this.userRepository.getAutoStackUserIds();
    await this.jobRepository.queueAll(userIds.map((userId) => ({ name: JobName.AutoStack, data: { userId } })));
    return JobStatus.Success;
  }

  /**
   * FL-953: stacks one owner's bursts and rapid retakes, best frame on top. Frames group like the assistant's
   * cull (FL-938 `groupBursts`: the camera's burst id, else photos taken within 2 seconds of the one before),
   * from one camera and one library at a time; a time-only chain also needs each photo to look like the one
   * before (search similarity above 0.92). A burst waits until every frame has its Best Photos score. Photos in
   * a stack, Locked, a partner's copy, or taken out of an automatic stack by the owner are left alone.
   * `unstack` takes the owner's automatic stacks apart (the setting was turned off); their own stacks stay.
   */
  @OnJob({ name: JobName.AutoStack, queue: QueueName.BackgroundTask })
  async handleAutoStack({ userId, unstack }: JobOf<JobName.AutoStack>): Promise<JobStatus> {
    if (unstack) {
      const stackIds = await this.stackRepository.getAutomaticStackIds(userId);
      if (stackIds.length === 0) return JobStatus.Skipped;
      let sequenced = false;
      await this.stackRepository.deleteAll(stackIds, undefined, (value) => {
        sequenced = value;
      });
      if (sequenced) await this.stackRepository.enqueueLocalEffects();
      else await this.eventRepository.emit('StackDeleteAll', { stackIds, userId });
      return JobStatus.Success;
    }
    if ((await this.userRepository.getAutoStackUserIds([userId])).length === 0) {
      return JobStatus.Skipped;
    }

    let after: { takenAt: Date; id: string } | null = null;
    let carry: AutoStackCandidate[] = [];
    let stacked = 0;
    while (true) {
      const page = await this.stackRepository.getAutoStackCandidates(userId, after, AUTO_STACK_PAGE);
      const frames = [...carry, ...page];
      const last = page.at(-1);
      if (last) after = { takenAt: last.takenAt, id: last.id };
      const groups = groupByCamera(frames);
      // a burst at the end of a full page may go on into the next one. ponytail: only the latest burst is carried,
      // so another camera's burst cut by the page edge is stacked in two parts; carry one per camera if it matters.
      carry = page.length === AUTO_STACK_PAGE ? (groups.pop() ?? []) : [];
      for (const group of groups) {
        stacked += await this.stackBurst(userId, group);
      }
      if (page.length < AUTO_STACK_PAGE) break;
    }
    if (stacked > 0) this.logger.log(`Stacked ${stacked} bursts automatically for user ${userId}`);
    return JobStatus.Success;
  }

  private async stackBurst(ownerId: string, burst: AutoStackCandidate[]): Promise<number> {
    let runs: AutoStackCandidate[][] = [burst];
    if (!burst[0].burstId) {
      const similarity = await this.stackRepository.getSimilarities(
        burst.slice(1).map((frame, index) => [burst[index].id, frame.id]),
      );
      runs = [[burst[0]]];
      for (const [index, frame] of burst.slice(1).entries()) {
        if ((similarity[index] ?? 0) > AUTO_STACK_SIMILARITY) runs.at(-1)!.push(frame);
        else runs.push([frame]);
      }
    }
    let count = 0;
    for (const run of runs) {
      if (run.length < 2 || run.some((frame) => !frame.scored)) continue;
      const lead = pickBurstLead(run.map((frame) => ({ ...frame, takenAt: frame.takenAt.getTime() })));
      let sequenced = false;
      const stack = await this.stackRepository.create(
        { ownerId, isAutomatic: true, autoVersion: AUTO_STACK_VERSION },
        [lead.id, ...run.filter((frame) => frame.id !== lead.id).map((frame) => frame.id)],
        undefined,
        (value) => {
          sequenced = value;
        },
      );
      if (sequenced) await this.stackRepository.enqueueLocalEffects();
      else await this.eventRepository.emit('StackCreate', { stackId: stack.id, userId: ownerId });
      count++;
    }
    return count;
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

type AutoStackCandidate = Awaited<ReturnType<StackRepository['getAutoStackCandidates']>>[number];

const AUTO_STACK_PAGE = 2000;
const AUTO_STACK_SIMILARITY = 0.92;

/** Bursts within one camera and library: `groupBursts` over each camera's photos, earliest first. */
const groupByCamera = (frames: AutoStackCandidate[]): AutoStackCandidate[][] => {
  const byId = new Map(frames.map((frame) => [frame.id, frame]));
  const cameras = new Map<string, CullFrame[]>();
  for (const frame of frames) {
    const cull: CullFrame = {
      id: frame.id,
      takenAt: frame.takenAt.getTime(),
      burstId: frame.burstId,
      score: null,
      isFavorite: false,
      rating: null,
    };
    const photos = cameras.get(frame.camera);
    if (photos) photos.push(cull);
    else cameras.set(frame.camera, [cull]);
  }
  return cameras
    .values()
    .flatMap((photos) => groupBursts(photos))
    .map((group) => group.map(({ id }) => byId.get(id)!))
    .toArray()
    .sort((a, b) => a[0].takenAt.getTime() - b[0].takenAt.getTime());
};
