import type { ServerAppReleasesResponseDto } from '@frameleaf/sdk';

/**
 * The phone "Get the app" sheet (owner request and approval 2026-10-16; prototype `AppCard.jsx`,
 * `?screen=library&appcard=ios|android`). These helpers decide whether it may open and what it
 * offers; `AppCard.svelte` draws it.
 *
 * It opens once, on the Photos library, in a phone browser (not a tablet, not a desktop, not the
 * home-screen web app), for a visit that began on the library rather than through a link to
 * something else, when this server names a release for the phone's platform
 * (`GET /server/app-releases`), and not within 30 days of being closed. The store button is its
 * only action: the store page itself offers "Open" when the app is already installed.
 */

export type AppCardPlatform = 'ios' | 'android';

/** What the sheet offers: the platform's store page, or (Android only) this server's own download page. */
export type AppCardOffer =
  { platform: AppCardPlatform; kind: 'store'; href: string } | { platform: 'android'; kind: 'downloads' };

export const APP_CARD_STORAGE_KEY = 'frameleaf:app-card:v1';
export const APP_CARD_SNOOZE_MS = 30 * 24 * 60 * 60 * 1000;
/** A screen whose shorter side is narrower than this is a phone (Android's tablet line, sw600dp). */
export const PHONE_MAX_SHORT_SIDE = 600;
export const LIBRARY_ROUTE_ID = '/(user)/photos/[[assetId=id]]';

/** Pages a visit can begin on and still count as arriving normally (the root and sign-in lead to the library). */
const NORMAL_ARRIVAL_PATHS = new Set(['/', '/photos', '/auth/login']);

/** The phone's platform from its user agent, or null for anything that is not an iPhone or an Android device. */
export const phonePlatform = (userAgent: string): AppCardPlatform | null => {
  if (/\b(iPhone|iPod)\b/.test(userAgent)) {
    return 'ios';
  }
  if (/\bAndroid\b/i.test(userAgent)) {
    return 'android';
  }
  return null;
};

/** A touch screen whose shorter side is phone-sized; it measures the screen, so rotation and split view don't matter. */
export const isPhoneScreen = (screen: { coarsePointer: boolean; width: number; height: number }): boolean =>
  screen.coarsePointer &&
  Math.min(screen.width, screen.height) > 0 &&
  Math.min(screen.width, screen.height) < PHONE_MAX_SHORT_SIDE;

/**
 * Whether the visit began normally: the page first loaded at the root, the library or sign-in, with
 * no query. A visit that began on an album, a photo, a search, a share or a notification link is a
 * deep link, and the sheet stays away for the rest of that page load.
 */
export const isNormalArrival = (firstUrl: URL): boolean => {
  const path = firstUrl.pathname.length > 1 ? firstUrl.pathname.replace(/\/+$/, '') : firstUrl.pathname;
  return NORMAL_ARRIVAL_PATHS.has(path) && firstUrl.search === '';
};

/** The address the page was first loaded at, from the navigation timing entry (client-side redirects don't change it). */
export const firstLoadUrl = (fallback: string): URL => {
  try {
    const [entry] = performance.getEntriesByType('navigation');
    return new URL(entry?.name || fallback);
  } catch {
    return new URL(fallback);
  }
};

const isHttps = (value: string | undefined): value is string => {
  if (!value) {
    return false;
  }
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
};

/**
 * What the sheet offers on this platform, or null when the server names no release for it. iPhone
 * needs the App Store page; Android prefers its store page and otherwise points to this server's
 * own signed download.
 */
export const appCardOffer = (
  releases: ServerAppReleasesResponseDto | null | undefined,
  platform: AppCardPlatform,
): AppCardOffer | null => {
  if (!releases) {
    return null;
  }
  if (platform === 'ios') {
    return releases.ios.available && isHttps(releases.ios.url)
      ? { platform, kind: 'store', href: releases.ios.url }
      : null;
  }
  if (isHttps(releases.android.storeUrl)) {
    return { platform, kind: 'store', href: releases.android.storeUrl };
  }
  return releases.android.available ? { platform, kind: 'downloads' } : null;
};

type ReadableStorage = Pick<Storage, 'getItem'>;
type WritableStorage = Pick<Storage, 'setItem'>;

/** localStorage, or undefined where reaching it throws (blocked site data, some private windows). */
export const appCardStorage = (): Storage | undefined => {
  try {
    return localStorage;
  } catch {
    return undefined;
  }
};

/** Whether the sheet was closed less than 30 days ago in this browser. */
export const isSnoozed = (storage: ReadableStorage | undefined, now: number): boolean => {
  try {
    const closedAt = Number(storage?.getItem(APP_CARD_STORAGE_KEY));
    return Number.isFinite(closedAt) && closedAt > 0 && closedAt <= now && now - closedAt < APP_CARD_SNOOZE_MS;
  } catch {
    // unreadable storage: the once-per-page-load guard still applies
    return false;
  }
};

/** Remember that the sheet was closed, so it stays away for 30 days. */
export const snooze = (storage: WritableStorage | undefined, now: number): void => {
  try {
    storage?.setItem(APP_CARD_STORAGE_KEY, String(now));
  } catch {
    // not remembered: it can come back on a later visit, never twice in one page load
  }
};

// Once per page load, even where storage can't remember a close and the layout remounts.
let shownThisLoad = false;

/** Whether the sheet has already opened in this page load. */
export const wasShownThisLoad = (): boolean => shownThisLoad;

/** Record that the sheet opened in this page load. */
export const markShownThisLoad = (): void => {
  shownThisLoad = true;
};

/** Tests only: forget that the sheet opened. */
export const resetShownThisLoad = (): void => {
  shownThisLoad = false;
};

export type AppCardContext = {
  userAgent: string;
  coarsePointer: boolean;
  screenWidth: number;
  screenHeight: number;
  /** Running as the home-screen web app (`display-mode: standalone`). */
  standalone: boolean;
  /** The visit began on the library (`isNormalArrival`). */
  arrivedNormally: boolean;
  /** The Photos library is showing, with no photo open. */
  onLibrary: boolean;
  /** Something else is in front: a dialog, the viewer or the one-time "Next steps" card. */
  otherSurface: boolean;
  snoozed: boolean;
  shownThisLoad: boolean;
};

/** The platform the sheet would open for right now, or null when any rule keeps it closed. */
export const appCardPlatform = (context: AppCardContext): AppCardPlatform | null => {
  if (
    !context.onLibrary ||
    !context.arrivedNormally ||
    context.standalone ||
    context.otherSurface ||
    context.snoozed ||
    context.shownThisLoad ||
    !isPhoneScreen({ coarsePointer: context.coarsePointer, width: context.screenWidth, height: context.screenHeight })
  ) {
    return null;
  }
  return phonePlatform(context.userAgent);
};
