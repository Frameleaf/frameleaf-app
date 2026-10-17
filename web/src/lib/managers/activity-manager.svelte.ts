import {
  createActivity,
  deleteActivity,
  getActivities,
  getActivityStatistics,
  ReactionLevel,
  ReactionType,
  type ActivityCreateDto,
  type ActivityResponseDto,
} from '@frameleaf/sdk';
import { t } from 'svelte-i18n';
import { get } from 'svelte/store';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { handlePromiseError } from '$lib/utils';
import { handleError } from '$lib/utils/handle-error';

type CacheKey = string;
type ActivityCache = {
  activities: ActivityResponseDto[];
  commentCount: number;
  likeCount: number;
  isLiked: ActivityResponseDto | null;
};

class ActivityManager {
  #albumId = $state<string | undefined>();
  #assetId = $state<string | undefined>();
  #activities = $state<ActivityResponseDto[]>([]);
  #commentCount = $state(0);
  #likeCount = $state(0);
  #isLiked = $state<ActivityResponseDto | null>(null);

  #cache = new Map<CacheKey, ActivityCache>();

  isLoading = $state(false);
  #viewVersion = 0;
  #refreshVersion = 0;
  #cacheIsCurrent: (() => boolean) | undefined;

  constructor() {
    eventManager.on({
      AuthLogout: () => {
        this.reset();
        this.#cache.clear();
        this.#cacheIsCurrent = undefined;
      },
    });
  }

  #prepareSession() {
    if (!this.#cacheIsCurrent?.()) {
      this.reset();
      this.#cache.clear();
      this.#cacheIsCurrent = authManager.captureSession();
    }
  }

  #captureView() {
    const version = this.#viewVersion;
    const isSessionCurrent = authManager.captureSession();
    return () => version === this.#viewVersion && isSessionCurrent();
  }

  get assetId() {
    return this.#assetId;
  }

  get activities() {
    return this.#activities;
  }

  get commentCount() {
    return this.#commentCount;
  }

  get likeCount() {
    return this.#likeCount;
  }

  get isLiked() {
    return this.#isLiked;
  }

  #getCacheKey(albumId: string, assetId?: string) {
    return `${albumId}:${assetId ?? ''}`;
  }

  async init(albumId: string, assetId?: string) {
    this.#prepareSession();
    if (albumId === this.#albumId && assetId && assetId === this.#assetId) {
      return;
    }

    this.#viewVersion++;
    this.#albumId = albumId;
    this.#assetId = assetId;
    const isCurrent = this.#captureView();
    try {
      await this.refreshActivities(albumId, assetId);
    } catch (error) {
      if (isCurrent()) {
        handleError(error, get(t)('errors.unable_to_get_comments_number'));
      }
    }
  }

  #invalidateCache(albumId: string, assetId?: string) {
    this.#cache.delete(this.#getCacheKey(albumId));
    this.#cache.delete(this.#getCacheKey(albumId, assetId));
  }

  async addActivity(dto: ActivityCreateDto) {
    this.#prepareSession();
    if (this.#albumId === undefined) {
      return;
    }

    const albumId = this.#albumId;
    const assetId = this.#assetId;
    const isSessionCurrent = authManager.captureSession();
    const isCurrent = this.#captureView();
    const activity = await createActivity({ activityCreateDto: dto }).catch((error: unknown) => {
      if (isCurrent()) {
        throw error;
      }
    });
    if (activity && isSessionCurrent()) {
      this.#invalidateCache(albumId, assetId);
    }
    if (!activity || !isCurrent()) {
      return;
    }
    this.#activities = [...this.#activities, activity];

    if (activity.type === ReactionType.Comment) {
      this.#commentCount++;
    }

    if (activity.type === ReactionType.Like) {
      this.#likeCount++;
    }

    handlePromiseError(this.refreshActivities(this.#albumId, this.#assetId));
    return activity;
  }

  async deleteActivity(activity: ActivityResponseDto, _?: number) {
    this.#prepareSession();
    if (!this.#albumId) {
      return;
    }
    const albumId = this.#albumId;
    const assetId = this.#assetId;
    const isSessionCurrent = authManager.captureSession();
    const isCurrent = this.#captureView();
    try {
      await deleteActivity({ id: activity.id });
    } catch (error) {
      if (isCurrent()) {
        throw error;
      }
      return;
    }
    if (isSessionCurrent()) {
      this.#invalidateCache(albumId, assetId);
    }
    if (!isCurrent()) {
      return;
    }
    this.#activities = this.#activities.filter(({ id }) => id !== activity.id);
    if (activity.type === ReactionType.Comment) {
      this.#commentCount--;
    }
    if (activity.type === ReactionType.Like) {
      this.#likeCount--;
    }
    handlePromiseError(this.refreshActivities(this.#albumId, this.#assetId));
  }

  async toggleLike() {
    this.#prepareSession();
    if (!this.#albumId) {
      return;
    }
    const isCurrent = this.#captureView();
    if (this.#isLiked) {
      await this.deleteActivity(this.#isLiked);
      if (isCurrent()) {
        this.#isLiked = null;
      }
    } else {
      const activity = await this.addActivity({
        albumId: this.#albumId,
        assetId: this.#assetId,
        type: ReactionType.Like,
      });
      if (isCurrent()) {
        this.#isLiked = activity ?? null;
      }
    }
  }

  async refreshActivities(albumId: string, assetId?: string) {
    this.#prepareSession();
    const version = ++this.#refreshVersion;
    const isViewCurrent = this.#captureView();
    const isCurrent = () => version === this.#refreshVersion && isViewCurrent();
    this.isLoading = true;
    try {
      const cacheKey = this.#getCacheKey(albumId, assetId);
      let cached = this.#cache.get(cacheKey);
      if (!cached) {
        const userId = authManager.user.id;
        const [activities, [liked], { comments, likes }] = await Promise.all([
          getActivities({ albumId, assetId }),
          getActivities({
            albumId,
            assetId,
            userId,
            $type: ReactionType.Like,
            level: assetId ? undefined : ReactionLevel.Album,
          }),
          getActivityStatistics({ albumId, assetId }),
        ]);
        if (!isCurrent()) {
          return;
        }
        cached = { activities, commentCount: comments, likeCount: likes, isLiked: liked ?? null };
        this.#cache.set(cacheKey, cached);
      }
      this.#activities = cached.activities;
      this.#commentCount = cached.commentCount;
      this.#likeCount = cached.likeCount;
      this.#isLiked = cached.isLiked;
    } catch (error) {
      if (isCurrent()) {
        throw error;
      }
    } finally {
      if (isCurrent()) {
        this.isLoading = false;
      }
    }
  }

  reset() {
    this.#viewVersion++;
    this.#refreshVersion++;
    this.isLoading = false;
    this.#isLiked = null;
    this.#albumId = undefined;
    this.#assetId = undefined;
    this.#activities = [];
    this.#commentCount = 0;
    this.#likeCount = 0;
  }
}

export const activityManager = new ActivityManager();
