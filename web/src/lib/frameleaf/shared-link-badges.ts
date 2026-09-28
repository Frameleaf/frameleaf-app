import type { SharedLinkResponseDto } from '@immich/sdk';

/**
 * What a shared link card says about its link (AL-21), ported from `linkBadges` in the design's
 * `shared-links-data.mjs`: Expired first and in the danger tone, then Password, Downloads, Uploads
 * and Metadata, then — while it is still open — when it expires, in the info tone. The prototype's
 * view count has no source in the product and is left out. The password is only ever a flag here:
 * its value never reaches the card.
 */
export type SharedLinkBadgeId = 'expired' | 'password' | 'download' | 'upload' | 'metadata' | 'expiry';

export interface SharedLinkBadge {
  id: SharedLinkBadgeId;
  tone: 'danger' | 'info' | 'neutral';
  /** For `expiry`, the moment it expires, to render relative to now. */
  at?: string;
}

export const isLinkExpired = (link: Pick<SharedLinkResponseDto, 'expiresAt'>, now = Date.now()) =>
  !!link.expiresAt && Date.parse(link.expiresAt) <= now;

export const sharedLinkBadges = (
  link: Pick<SharedLinkResponseDto, 'expiresAt' | 'password' | 'allowDownload' | 'allowUpload' | 'showMetadata'>,
  now = Date.now(),
): SharedLinkBadge[] => {
  const expired = isLinkExpired(link, now);
  const badges: SharedLinkBadge[] = [];
  if (expired) {
    badges.push({ id: 'expired', tone: 'danger' });
  }
  if (link.password) {
    badges.push({ id: 'password', tone: 'neutral' });
  }
  if (link.allowDownload) {
    badges.push({ id: 'download', tone: 'neutral' });
  }
  if (link.allowUpload) {
    badges.push({ id: 'upload', tone: 'neutral' });
  }
  if (link.showMetadata) {
    badges.push({ id: 'metadata', tone: 'neutral' });
  }
  if (link.expiresAt && !expired) {
    badges.push({ id: 'expiry', tone: 'info', at: link.expiresAt });
  }
  return badges;
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * "in 3 days", "2 months ago": the prototype's `relativeDuration` steps (minutes under an hour,
 * hours under a day, days under 60 days, months under a year, then years), phrased by the
 * browser's own relative-time formatter so every language reads naturally.
 */
export const relativeTime = (at: string | number | Date, now = Date.now(), locale?: string): string => {
  const delta = new Date(at).getTime() - now;
  const span = Math.abs(delta);
  const sign = delta < 0 ? -1 : 1;
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'always' });
  if (span < HOUR) {
    return format.format(sign * Math.max(1, Math.round(span / MINUTE)), 'minute');
  }
  if (span < DAY) {
    return format.format(sign * Math.round(span / HOUR), 'hour');
  }
  if (span < 60 * DAY) {
    return format.format(sign * Math.round(span / DAY), 'day');
  }
  if (span < 365 * DAY) {
    return format.format(sign * Math.round(span / (30 * DAY)), 'month');
  }
  return format.format(sign * Math.round(span / (365 * DAY)), 'year');
};
