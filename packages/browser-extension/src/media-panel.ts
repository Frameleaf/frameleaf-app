import {
  readMediaAddress,
  type MediaAddress,
  type MediaPlatform,
} from './media-address';
import type { MediaOperationView, MediaProblem } from './media-api';
import type { MediaRequest } from './media-background';
import type {
  MediaHistoryChoice,
  MediaQualityChoice,
  MediaSaveChoices,
} from './media-queue';

/**
 * FL-1449: what the Page tab's media half decides and sends, kept apart from the panel that shows
 * it. The page's own address chooses the form at once (a whole channel or account is followed, one
 * video or post is downloaded, any other site lists its media); your Library's own reading of the
 * page then fills in the real names. Nothing here talks to a page or to the Library.
 */

type SaveId = keyof MediaSaveChoices;
/** The "What to save" switches of each platform (the Creators platform table in web/). */
export const MEDIA_PLATFORMS: Record<
  MediaPlatform,
  { name: string; saves: { id: SaveId; label: string; on: boolean }[] }
> = {
  youtube: {
    name: 'YouTube',
    saves: [
      { id: 'videos', label: 'Videos', on: true },
      { id: 'shorts', label: 'Shorts', on: true },
      { id: 'live', label: 'Finished live streams', on: false },
    ],
  },
  x: {
    name: 'X',
    saves: [
      { id: 'images', label: 'Pictures', on: true },
      { id: 'videos', label: 'Videos and GIFs', on: true },
      { id: 'replies', label: 'Their replies with media', on: false },
      { id: 'reposts', label: 'Reposts', on: false },
    ],
  },
  pinterest: {
    name: 'Pinterest',
    saves: [
      { id: 'pins', label: 'Pins', on: true },
      { id: 'videos', label: 'Video pins', on: true },
    ],
  },
  facebook: {
    name: 'Facebook',
    saves: [
      { id: 'photos', label: 'Photos', on: true },
      { id: 'videos', label: 'Videos', on: true },
      { id: 'reels', label: 'Reels', on: true },
    ],
  },
  reddit: {
    name: 'Reddit',
    saves: [
      { id: 'images', label: 'Pictures', on: true },
      { id: 'videos', label: 'Videos', on: true },
    ],
  },
  bluesky: {
    name: 'Bluesky',
    saves: [
      { id: 'images', label: 'Pictures', on: true },
      { id: 'videos', label: 'Videos', on: true },
    ],
  },
  other: { name: '', saves: [] },
};
export const defaultSaves = (platform: MediaPlatform): MediaSaveChoices =>
  Object.fromEntries(
    MEDIA_PLATFORMS[platform].saves.map(({ id, on }) => [id, on]),
  );

/** "Their latest 20": the count the approved wording names. */
export const RECENT_COUNT = 20;
export type MediaReach = 'recent' | 'all' | 'since' | 'new';
export const MEDIA_REACHES: { id: MediaReach; label: string }[] = [
  { id: 'recent', label: `Their latest ${RECENT_COUNT}, then everything new` },
  { id: 'all', label: 'Everything they’ve posted' },
  { id: 'since', label: 'Since a date' },
  { id: 'new', label: 'Only new posts from now on' },
];
export const MEDIA_QUALITY_LABELS: {
  id: MediaQualityChoice;
  label: string;
}[] = [
  { id: 'best', label: 'Best' },
  { id: '1080', label: '1080p' },
  { id: '720', label: '720p' },
  { id: 'audio', label: 'Sound only' },
];
export type MediaInterval = 15 | 60 | 360 | 1440;
export const MEDIA_INTERVALS: { id: MediaInterval; label: string }[] = [
  { id: 15, label: 'Every 15 minutes' },
  { id: 60, label: 'Every hour' },
  { id: 360, label: 'Every 6 hours' },
  { id: 1440, label: 'Once a day' },
];

export interface PageChoice {
  /** Which form the media half shows. */
  kind: 'follow' | 'download' | 'other';
  platform: MediaPlatform;
  /** "channel", "video", "post"… as the button and the card say it. */
  what: MediaAddress['what'];
  icon: 'rss' | 'download';
  title: string;
  hint: string;
}
/**
 * What the second half of the Page tab is on this page, from its address alone. A page that is not
 * one creator's and not one post (a site's home page, any other site) lists its media instead.
 */
export function pageChoice(url: string | null | undefined): PageChoice {
  const read = url ? readMediaAddress(url) : null;
  if (!read || read.platform === 'other')
    return {
      kind: 'other',
      platform: 'other',
      what: 'page',
      icon: 'download',
      title: 'Download its media',
      hint: 'Video, pictures and sound',
    };
  return read.action === 'follow'
    ? {
        kind: 'follow',
        platform: read.platform,
        what: read.what,
        icon: 'rss',
        title: `Follow this ${read.what}`,
        hint: `Save what they post on ${MEDIA_PLATFORMS[read.platform].name}`,
      }
    : {
        kind: 'download',
        platform: read.platform,
        what: read.what,
        icon: 'download',
        title: `Download this ${read.what}`,
        hint: 'Just this, with its title and tags',
      };
}

/**
 * What "How far back" sends. Null until one is chosen (and, for since a date, a real date): it is
 * asked, never assumed, so there is no default to fall back to.
 */
export function historyOf(
  reach: MediaReach | '',
  since: string,
): MediaHistoryChoice | null {
  if (reach === 'recent') return { mode: 'recent', count: RECENT_COUNT };
  if (reach === 'all' || reach === 'new') return { mode: reach };
  if (reach !== 'since' || !/^\d{4}-\d{2}-\d{2}$/.test(since)) return null;
  const from = new Date(`${since}T00:00:00`);
  return Number.isFinite(from.getTime())
    ? { mode: 'since', since: from.toISOString() }
    : null;
}

const ready = (
  operation: MediaOperationView | null,
): operation is MediaOperationView => operation?.state === 'ready';
/** A whole channel or account your Library can follow. */
export const followable = (operation: MediaOperationView | null) =>
  ready(operation) &&
  operation.kind === 'feed' &&
  !!(operation.creatorId ?? operation.creator);
/** Your Library can file what it found under a creator; otherwise a collection has to be chosen. */
export const hasCreator = (operation: MediaOperationView | null) =>
  !!operation?.creator || !!operation?.creatorId;

/** Whether a video is being saved: what the Library found, or the platform's usual until it has. */
export const savesVideo = (
  platform: MediaPlatform,
  operation: MediaOperationView | null,
) =>
  operation && operation.items.length > 0
    ? operation.items.some((item) => item.kind === 'video')
    : platform === 'youtube' || platform === 'facebook';
/** "1 video and 2 pictures". */
export function itemSummary(operation: MediaOperationView | null): string {
  const words = { video: 'video', image: 'picture', audio: 'sound' } as const;
  const parts = (['video', 'image', 'audio'] as const).flatMap((kind) => {
    const count =
      operation?.items.filter((item) => item.kind === kind).length ?? 0;
    return count > 0
      ? [`${count} ${words[kind]}${count === 1 ? '' : 's'}`]
      : [];
  });
  return parts.length > 1
    ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`
    : (parts[0] ?? '');
}

const FACEBOOK_NOT_A_PAGE = [
  'watch',
  'reel',
  'photo',
  'share',
  'groups',
  'events',
  'marketplace',
  'gaming',
  'stories',
];
/**
 * The own page of whoever posted the one video or post at this address, for "Follow them too".
 * Taken from the address where it names the account; on YouTube, where it does not, from the
 * channel id your Library read. Null when neither says, and the switch is then not offered.
 */
export function creatorAddress(
  pageUrl: string,
  creatorId?: string | null,
): string | null {
  const read = readMediaAddress(pageUrl);
  if (!read || read.action !== 'download') return null;
  const url = new URL(pageUrl);
  const site = url.hostname.replace(/^(www|m|mobile)\./, '');
  const path = url.pathname.split('/').filter(Boolean);
  const name = (value: string | undefined) =>
    value && /^[\w.:-]{1,253}$/.test(value) ? value : null;
  let address: string | null = null;
  if (read.platform === 'x') {
    // x.com/i/status/… names no account
    if (path[1] === 'status' && path[0] !== 'i' && name(path[0]))
      address = `https://x.com/${path[0]}`;
  } else if (read.platform === 'bluesky') {
    if (name(path[1])) address = `https://bsky.app/profile/${path[1]}`;
  } else if (read.platform === 'reddit') {
    if ((path[0] === 'user' || path[0] === 'u') && name(path[1]))
      address = `https://www.reddit.com/user/${path[1]}`;
  } else if (read.platform === 'facebook') {
    if (
      site.endsWith('facebook.com') &&
      ['videos', 'posts'].includes(path[1]) &&
      !FACEBOOK_NOT_A_PAGE.includes(path[0]) &&
      name(path[0])
    )
      address = `https://www.facebook.com/${path[0]}`;
  } else if (read.platform === 'youtube' && creatorId) {
    if (/^UC[\w-]{22}$/.test(creatorId))
      address = `https://www.youtube.com/channel/${creatorId}`;
    else if (/^@[\w.-]{3,30}$/.test(creatorId))
      address = `https://www.youtube.com/${creatorId}`;
  }
  // only ever an address that itself reads as a whole account
  return address && readMediaAddress(address)?.action === 'follow'
    ? address
    : null;
}

type Pick<T extends MediaRequest['type']> = Extract<MediaRequest, { type: T }>;
export interface FollowChoices {
  platform: MediaPlatform;
  reach: MediaReach | '';
  since: string;
  saves: MediaSaveChoices;
  quality: MediaQualityChoice;
  interval: MediaInterval;
}
/**
 * The follow a finished preview and these choices ask for, or null while something is missing: a
 * preview your Library can follow, or how far back.
 */
export function followRequest(
  preview: MediaOperationView | null,
  choices: FollowChoices,
): Pick<'media-subscribe'> | null {
  const history = historyOf(choices.reach, choices.since);
  if (!followable(preview) || !preview || !history) return null;
  const platform = MEDIA_PLATFORMS[choices.platform];
  // only the switches this platform has, as they stand
  const saves = Object.fromEntries(
    platform.saves.map(({ id, on }) => [id, choices.saves[id] ?? on]),
  );
  return {
    type: 'media-subscribe',
    label: [preview.creator, platform.name || preview.provider]
      .filter(Boolean)
      .join(' · '),
    inspectionId: preview.id,
    history,
    intervalMinutes: choices.interval,
    ...(platform.saves.length > 0 && { saves }),
    // the quality choice is offered for YouTube only
    ...(choices.platform === 'youtube' &&
      choices.quality !== 'best' && { quality: choices.quality }),
  };
}
/**
 * The download of everything a finished check found, or null while it cannot be sent. No collection
 * is named when your Library knows the creator: it files the items under them. Only when it found
 * no creator does a collection have to be chosen, because the Library would refuse it otherwise.
 */
export function downloadRequest(
  operation: MediaOperationView | null,
  choices: {
    label: string;
    video: boolean;
    quality: MediaQualityChoice;
    albumId?: string;
  },
): Pick<'media-download'> | null {
  if (!ready(operation) || operation.items.length === 0) return null;
  const filed = hasCreator(operation);
  if (!filed && !choices.albumId) return null;
  return {
    type: 'media-download',
    label: choices.label,
    inspectionId: operation.id,
    itemIds: operation.items.map((item) => item.id),
    ...(!filed && { albumId: choices.albumId }),
    tagIds: [],
    overrideSuppression: false,
    ...(choices.video &&
      choices.quality !== 'best' && { quality: choices.quality }),
  };
}

export type InspectionReply =
  | { ok: true; operation?: MediaOperationView }
  | { ok: false; error: string; problem?: MediaProblem }
  | null;
const NO_ANSWER = 'Could not reach the extension. Reopen it and try again.';
/**
 * Follows one check your Library is making until it is ready. A reply for a check the panel has
 * moved on from (another was started, or the view was left) changes nothing: every start and every
 * `leave` makes all earlier replies stale, whichever order they come back in.
 */
export class InspectionWatch {
  private turn = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(
    private readonly read: (id: string) => Promise<InspectionReply>,
    private readonly changed: (operation: MediaOperationView) => void,
    private readonly failed: (error: string, problem?: MediaProblem) => void,
  ) {}
  /** Asks for a check, then follows it. */
  async begin(start: () => Promise<InspectionReply>) {
    const mine = this.next();
    const reply = await start().catch(() => null);
    if (mine !== this.turn) return;
    if (reply?.ok && reply.operation) this.take(mine, reply.operation);
    else
      this.failed(
        reply && !reply.ok ? reply.error : NO_ANSWER,
        reply && !reply.ok ? reply.problem : undefined,
      );
  }
  /** Carries on with a check that was already started. */
  resume(operation: MediaOperationView) {
    this.take(this.next(), operation);
  }
  /** The view moved on: nothing still on its way back is acted on. */
  leave() {
    this.next();
  }
  private next() {
    clearTimeout(this.timer);
    return ++this.turn;
  }
  private take(mine: number, operation: MediaOperationView) {
    this.changed(operation);
    if (operation.state === 'inspecting')
      this.timer = setTimeout(() => void this.poll(mine, operation.id), 1500);
  }
  private async poll(mine: number, id: string) {
    const reply = await this.read(id).catch(() => null);
    if (mine !== this.turn) return;
    if (reply?.ok && reply.operation) this.take(mine, reply.operation);
    else if (reply?.ok)
      this.timer = setTimeout(() => void this.poll(mine, id), 3000);
    // any error ends the wait
    else this.failed(reply ? reply.error : NO_ANSWER, reply?.problem);
  }
}
