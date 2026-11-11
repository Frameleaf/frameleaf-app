/**
 * FL-1448 Creators in Boards: what each platform's page is made of, how a creator's page asks the
 * Library for its items, and the area's address. Pure functions; nothing is fetched here.
 */
import {
  AssetMediaSize,
  getBaseUrl,
  MediaItemKind,
  MediaQuality,
  MediaReachMode,
  MediaSection,
  MediaSubscriptionState,
  type MediaCreatorItemResponse,
  type MediaCreatorResponseDto,
  type MediaReach,
  type MediaSaves,
} from '@frameleaf/sdk';
import { mdiButterflyOutline, mdiFacebook, mdiPinterest, mdiReddit, mdiWeb, mdiYoutube } from '@mdi/js';
import type { Translations } from 'svelte-i18n';
import { readMediaAddress, type MediaAddress, type MediaPlatform } from '$lib/frameleaf/media-address';
import { getAssetMediaUrl } from '$lib/utils';

export type CreatorSectionId =
  'videos' | 'shorts' | 'live' | 'playlists' | 'posts' | 'media' | 'photos' | 'reels' | 'boards' | 'pins';
/** How a section lays its items out. */
export type CreatorLayout = 'videos' | 'shorts' | 'timeline' | 'media' | 'groups' | 'pins' | 'mixed';
export type CreatorKind = 'all' | 'video' | 'image';
export type CreatorState = 'on' | 'paused' | 'attention' | 'saved';

type Save = { id: keyof MediaSaves; label: Translations; on: boolean };
type Platform = {
  name: string;
  icon: string | null;
  letter?: string;
  needsSignIn?: boolean;
  /** `sections[0]` is where a creator's page opens. */
  sections: CreatorSectionId[];
  saves: Save[];
};

const pictures: Save = { id: 'images', label: 'frameleaf_creators_save_pictures', on: true };
const videos: Save = { id: 'videos', label: 'frameleaf_creators_save_videos', on: true };

/** The approved design's PLATFORMS table (prototype boards-creators.mjs). */
export const CREATOR_PLATFORMS: Record<MediaPlatform, Platform> = {
  youtube: {
    name: 'YouTube',
    icon: mdiYoutube,
    sections: ['videos', 'shorts', 'live', 'playlists'],
    saves: [
      videos,
      { id: 'shorts', label: 'frameleaf_creators_save_shorts', on: true },
      { id: 'live', label: 'frameleaf_creators_save_live', on: false },
    ],
  },
  x: {
    name: 'X',
    icon: null,
    letter: '𝕏',
    sections: ['posts', 'media', 'videos'],
    saves: [
      pictures,
      { id: 'videos', label: 'frameleaf_creators_save_videos_gifs', on: true },
      { id: 'replies', label: 'frameleaf_creators_save_replies', on: false },
      { id: 'reposts', label: 'frameleaf_creators_save_reposts', on: false },
    ],
  },
  pinterest: {
    name: 'Pinterest',
    icon: mdiPinterest,
    sections: ['boards', 'pins'],
    saves: [
      { id: 'pins', label: 'frameleaf_creators_save_pins', on: true },
      { id: 'videos', label: 'frameleaf_creators_save_video_pins', on: true },
    ],
  },
  facebook: {
    name: 'Facebook',
    icon: mdiFacebook,
    needsSignIn: true,
    sections: ['posts', 'photos', 'videos', 'reels'],
    saves: [
      { id: 'photos', label: 'frameleaf_creators_save_photos', on: true },
      videos,
      { id: 'reels', label: 'frameleaf_creators_save_reels', on: true },
    ],
  },
  reddit: { name: 'Reddit', icon: mdiReddit, sections: ['posts', 'media'], saves: [pictures, videos] },
  bluesky: { name: 'Bluesky', icon: mdiButterflyOutline, sections: ['posts', 'media'], saves: [pictures, videos] },
  other: { name: '', icon: mdiWeb, sections: ['media'], saves: [] },
};

export const CREATOR_SECTION_LABELS: Record<CreatorSectionId, Translations> = {
  videos: 'frameleaf_creators_section_videos',
  shorts: 'frameleaf_creators_section_shorts',
  live: 'frameleaf_creators_section_live',
  playlists: 'frameleaf_creators_section_playlists',
  posts: 'frameleaf_creators_section_posts',
  media: 'frameleaf_creators_section_media',
  photos: 'frameleaf_creators_section_photos',
  reels: 'frameleaf_creators_section_reels',
  boards: 'frameleaf_creators_section_boards',
  pins: 'frameleaf_creators_section_pins',
};

export const CREATOR_QUALITIES = [MediaQuality.Best, MediaQuality.$1080, MediaQuality.$720, MediaQuality.Audio];
export const CREATOR_REACHES = [MediaReachMode.Recent, MediaReachMode.All, MediaReachMode.Since, MediaReachMode.New];
/** "Their latest 20": the count the approved wording names. */
export const CREATOR_RECENT_COUNT = 20;

/** The platform a site's name (as the Library's extractor reports it) or address belongs to. */
export const creatorPlatform = (provider: string | null | undefined, url?: string | null): MediaPlatform => {
  const name = (provider ?? '').toLowerCase();
  if (name.includes('youtube')) {
    return 'youtube';
  }
  if (name === 'x' || name.includes('twitter')) {
    return 'x';
  }
  for (const platform of ['pinterest', 'facebook', 'reddit', 'bluesky'] as const) {
    if (name.includes(platform)) {
      return platform;
    }
  }
  if (name.includes('bsky')) {
    return 'bluesky';
  }
  return (url ? readMediaAddress(url)?.platform : undefined) ?? 'other';
};

/** The name shown for a platform; a site the design has no page for keeps its own name. */
export const platformName = (platform: MediaPlatform, provider?: string | null) =>
  CREATOR_PLATFORMS[platform].name || provider || '';

export const defaultSaves = (platform: MediaPlatform): MediaSaves =>
  Object.fromEntries(CREATOR_PLATFORMS[platform].saves.map(({ id, on }) => [id, on]));

/** A platform's switches, as a subscription has them (a switch it never set keeps the design's default). */
export const savesFor = (platform: MediaPlatform, saved: MediaSaves | undefined): MediaSaves => ({
  ...defaultSaves(platform),
  ...Object.fromEntries(
    CREATOR_PLATFORMS[platform].saves.flatMap(({ id }) => (saved?.[id] === undefined ? [] : [[id, saved[id]]])),
  ),
});

export const creatorSection = (platform: MediaPlatform, section: string | null | undefined): CreatorSectionId => {
  const { sections } = CREATOR_PLATFORMS[platform];
  return sections.find((id) => id === section) ?? sections[0];
};

/**
 * What a section asks the Library for and how it is laid out. Media and Videos on an account's page
 * are cuts of the same posts; Boards and Playlists group a section by the list each item came from.
 */
export const sectionRequest = (
  platform: MediaPlatform,
  section: CreatorSectionId,
): { section?: MediaSection; kind?: MediaItemKind; layout: CreatorLayout } => {
  switch (section) {
    case 'videos': {
      return platform === 'youtube' || platform === 'facebook'
        ? { section: MediaSection.Video, layout: 'videos' }
        : { section: MediaSection.Post, kind: MediaItemKind.Video, layout: 'media' };
    }
    case 'shorts': {
      return { section: MediaSection.Short, layout: 'shorts' };
    }
    case 'live': {
      return { section: MediaSection.Live, layout: 'videos' };
    }
    case 'reels': {
      return { section: MediaSection.Reel, layout: 'shorts' };
    }
    case 'playlists': {
      return { layout: 'groups' };
    }
    case 'posts': {
      return { section: MediaSection.Post, layout: 'timeline' };
    }
    case 'photos': {
      return { section: MediaSection.Photo, layout: 'pins' };
    }
    case 'boards': {
      return { section: MediaSection.Pin, layout: 'groups' };
    }
    case 'pins': {
      return { section: MediaSection.Pin, layout: 'pins' };
    }
    default: {
      return platform === 'other' ? { layout: 'mixed' } : { section: MediaSection.Post, layout: 'media' };
    }
  }
};

export const creatorKind = (value: string | null | undefined): CreatorKind =>
  value === 'video' || value === 'image' ? value : 'all';

export const creatorState = (creator: MediaCreatorResponseDto): CreatorState => {
  const status = creator.following ? creator.subscription?.status : undefined;
  if (status === MediaSubscriptionState.Paused) {
    return 'paused';
  }
  if (status === MediaSubscriptionState.Attention) {
    return 'attention';
  }
  return status === MediaSubscriptionState.Active ? 'on' : 'saved';
};

/** "20 minutes ago", "in 4 hours", "yesterday". */
export const relativeTime = (value: string, locale?: string | null, now = Date.now()) => {
  const seconds = (new Date(value).getTime() - now) / 1000;
  const format = new Intl.RelativeTimeFormat(locale ?? undefined, { numeric: 'auto' });
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [
    ['minute', 60],
    ['hour', 3600],
    ['day', 86_400],
    ['month', 2_592_000],
    ['year', 31_536_000],
  ];
  let [unit, size] = steps[0];
  for (const step of steps) {
    if (Math.abs(seconds) >= step[1]) {
      [unit, size] = step;
    }
  }
  return format.format(Math.trunc(seconds / size), unit);
};

/** The status line of a creator: the key and what its sentence needs. */
export const creatorStatus = (
  creator: MediaCreatorResponseDto,
  locale?: string | null,
  now = Date.now(),
): { key: Translations; values?: Record<string, string> } => {
  const state = creatorState(creator);
  const subscription = creator.subscription;
  if (state === 'attention') {
    return { key: 'frameleaf_creators_state_attention' };
  }
  if (state === 'saved' || !subscription) {
    return { key: 'frameleaf_creators_state_saved' };
  }
  const checked = subscription.lastSuccessAt ? relativeTime(subscription.lastSuccessAt, locale, now) : undefined;
  if (state === 'paused') {
    return checked
      ? { key: 'frameleaf_creators_state_paused', values: { checked } }
      : { key: 'frameleaf_creators_state_paused_unchecked' };
  }
  // A check that is due shows as "now", never as a time that has passed.
  const next = relativeTime(
    subscription.nextCheckAt,
    locale,
    Math.min(now, new Date(subscription.nextCheckAt).getTime()),
  );
  return checked
    ? { key: 'frameleaf_creators_state_on', values: { checked, next } }
    : { key: 'frameleaf_creators_state_on_unchecked', values: { next } };
};

/** What the form's "How far back" choice sends; nothing until one is chosen (and a date, for since). */
export const buildReach = (mode: MediaReachMode | undefined, since: string): MediaReach | undefined => {
  if (!mode) {
    return;
  }
  if (mode === MediaReachMode.Recent) {
    return { mode, count: CREATOR_RECENT_COUNT };
  }
  if (mode !== MediaReachMode.Since) {
    return { mode };
  }
  const date = new Date(`${since}T00:00:00`);
  return Number.isFinite(date.getTime()) ? { mode, since: date.toISOString() } : undefined;
};

/** The date field's value for a stored reach. */
export const reachDate = (reach: MediaReach | undefined) => {
  const date = reach?.since ? new Date(reach.since) : undefined;
  if (!date || !Number.isFinite(date.getTime())) {
    return '';
  }
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

/** 754 → "12:34", 3735 → "1:02:15". */
export const mediaLength = (seconds: number | null | undefined) => {
  if (!seconds || seconds <= 0) {
    return '';
  }
  const whole = Math.round(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = String(whole % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
};

/** "Oct 25", with the year once it is not this one. */
export const postedDate = (value: string | null | undefined, locale?: string | null, now = new Date()) => {
  if (!value) {
    return '';
  }
  const date = new Date(value);
  return date.toLocaleDateString(locale ?? undefined, {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() === now.getFullYear() ? undefined : 'numeric',
  });
};

/** How much of an item has been watched, 0–100. */
export const watchedPercent = (item: MediaCreatorItemResponse) => {
  if (item.watched) {
    return 100;
  }
  return item.duration && item.position > 0 ? Math.min(99, Math.round((item.position / item.duration) * 100)) : 0;
};

export const creatorInitials = (name: string) =>
  name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => [...word][0]?.toUpperCase() ?? '')
    .join('');

export const creatorAvatarUrl = (id: string) => `${getBaseUrl()}/media-creators/${encodeURIComponent(id)}/avatar`;
export const creatorBannerUrl = (id: string) => `${getBaseUrl()}/media-creators/${encodeURIComponent(id)}/banner`;
/** The cover the site gave a video, or the Library's own thumbnail of the file. */
export const creatorItemImage = (item: Pick<MediaCreatorItemResponse, 'assetId' | 'hasPoster'>) =>
  item.hasPoster
    ? `${getBaseUrl()}/media-creators/items/${encodeURIComponent(item.assetId)}/poster`
    : getAssetMediaUrl({ id: item.assetId, size: AssetMediaSize.Thumbnail });

export type CreatorPost = {
  id: string;
  first: MediaCreatorItemResponse;
  media: MediaCreatorItemResponse[];
};
/** A post's attachments share its `postId`; the timeline shows each post once, in list order. */
export const groupPosts = (items: MediaCreatorItemResponse[]): CreatorPost[] => {
  const posts = new Map<string, CreatorPost>();
  for (const item of items) {
    const id = item.postId ?? item.assetId;
    const post = posts.get(id);
    if (post) {
      post.media.push(item);
    } else {
      posts.set(id, { id, first: item, media: [item] });
    }
  }
  return [...posts.values()];
};

export type CreatorGroup = { id: string; title: string; items: MediaCreatorItemResponse[] };
/** Pinterest boards and playlists: the items that came from the same list. */
export const groupLists = (items: MediaCreatorItemResponse[]): CreatorGroup[] => {
  const groups = new Map<string, CreatorGroup>();
  for (const item of items) {
    if (!item.playlistId || !item.playlistTitle) {
      continue;
    }
    const group = groups.get(item.playlistId);
    if (group) {
      group.items.push(item);
    } else {
      groups.set(item.playlistId, { id: item.playlistId, title: item.playlistTitle, items: [item] });
    }
  }
  return [...groups.values()];
};

/** The noun the design uses for what an address is ("channel", "post"…). */
export const ADDRESS_NOUNS: Record<MediaAddress['what'], Translations> = {
  channel: 'frameleaf_creators_what_channel',
  account: 'frameleaf_creators_what_account',
  profile: 'frameleaf_creators_what_profile',
  board: 'frameleaf_creators_what_board',
  page: 'frameleaf_creators_what_page',
  video: 'frameleaf_creators_what_video',
  short: 'frameleaf_creators_what_short',
  playlist: 'frameleaf_creators_what_playlist',
  post: 'frameleaf_creators_what_post',
  pin: 'frameleaf_creators_what_pin',
};

/** The handle or site an address names, shown until the Library has read the real name. */
export const addressLabel = (address: string) => {
  try {
    const url = new URL(address.trim());
    const first = url.pathname.split('/').find(Boolean);
    return first?.startsWith('@') ? first : url.hostname.replace(/^(www|m|mobile)\./, '');
  } catch {
    return '';
  }
};

/* ---- The area's address: /pro?area=creators… ---- */

export const CREATORS_AREA = 'creators';
export type CreatorsLocation = {
  /** A creator's page; without one, Home or the Subscriptions list. */
  creator: string | null;
  view: 'home' | 'subscriptions';
  section: string | null;
  kind: CreatorKind;
  unwatched: boolean;
  /** The Subscription panel on the creator's page. */
  settings: boolean;
  /** The item open in Details (its asset id). */
  item: string | null;
};

export const isCreatorsArea = (url: URL) =>
  /^\/pro\/?$/.test(url.pathname) && url.searchParams.get('area') === CREATORS_AREA;

export const readCreatorsLocation = (url: URL): CreatorsLocation => {
  const get = (name: string) => url.searchParams.get(name);
  const creator = get('creator');
  return {
    creator,
    view: !creator && get('view') === 'subscriptions' ? 'subscriptions' : 'home',
    section: creator ? get('section') : null,
    kind: creator ? creatorKind(get('kind')) : 'all',
    unwatched: !!creator && get('unwatched') === '1',
    settings: !!creator && get('settings') === '1',
    item: creator ? get('item') : null,
  };
};

export const creatorsHref = (location: Partial<CreatorsLocation> = {}) => {
  const search = new URLSearchParams({ area: CREATORS_AREA });
  if (location.creator) {
    search.set('creator', location.creator);
    if (location.section) {
      search.set('section', location.section);
    }
    if (location.kind && location.kind !== 'all') {
      search.set('kind', location.kind);
    }
    if (location.unwatched) {
      search.set('unwatched', '1');
    }
    if (location.settings) {
      search.set('settings', '1');
    }
    if (location.item) {
      search.set('item', location.item);
    }
  } else if (location.view === 'subscriptions') {
    search.set('view', 'subscriptions');
  }
  return `/pro?${search}`;
};
