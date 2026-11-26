/**
 * What the Linked Households screens (FL-998) say about a link or a received space, decided from
 * the server's short machine words. The words are text on purpose (new enum values break the
 * native apps), so an unknown one falls through to a calm default instead of an error.
 */
import type { HouseholdInboundShareDto, HouseholdLinkDto } from '@frameleaf/sdk';

/** The kit Pill's tones (`Pill.svelte` `KitTone`; plain tsc can't read a type out of a .svelte module). */
type KitTone = 'good' | 'warn' | 'bad' | 'off';

/** The link's own limit on the Cloud side, repeated in the page's help line. */
export const HOUSEHOLD_LINK_LIMIT = 10;

/**
 * The invitation as typed or pasted. A pasted address keeps only its last part, and spaces go; the
 * case is kept, because the long form of an invitation is case-sensitive.
 */
export const invitationCode = (input: string) => {
  const text = input.trim();
  if (/^https?:\/\//i.test(text)) {
    try {
      const url = new URL(text);
      const last = url.pathname.split('/').findLast(Boolean);
      return decodeURIComponent(last ?? '').replaceAll(/\s/g, '');
    } catch {
      return text.replaceAll(/\s/g, '');
    }
  }
  return text.replaceAll(/\s/g, '');
};

export type HouseholdRow = {
  tone: KitTone;
  status: 'home' | 'direct' | 'relay' | 'offline' | 'paused' | 'home_only' | 'checking';
  /** Why, when there is a reason to say. `seen` and `offline` take the last-seen time. */
  note?:
    'seen' | 'offline' | 'home_only' | 'licence' | 'their_licence' | 'cloud' | 'their_cloud' | 'key' | 'cloud_down';
};

/**
 * One row of the list. `licensed` is whether this server holds a Server licence, undefined until
 * Cloud has answered: the server's `licence` reason covers either side, so the row names a side
 * only once it is known.
 */
export const householdRow = (link: HouseholdLinkDto, licensed: boolean | undefined): HouseholdRow => {
  if (link.paused) {
    switch (link.reason) {
      case 'licence': {
        if (licensed === undefined) {
          return { tone: 'warn', status: 'paused' };
        }
        return { tone: 'warn', status: 'paused', note: licensed ? 'their_licence' : 'licence' };
      }
      case 'unlinked': {
        return { tone: 'warn', status: 'paused', note: 'cloud' };
      }
      case 'peer-unlinked': {
        return { tone: 'warn', status: 'paused', note: 'their_cloud' };
      }
      case 'key': {
        return { tone: 'warn', status: 'paused', note: 'key' };
      }
      default: {
        return { tone: 'warn', status: 'paused', note: 'cloud_down' };
      }
    }
  }
  if (link.reason === 'home-network') {
    return { tone: 'off', status: 'home_only', note: 'home_only' };
  }
  if (link.reason === 'unreachable') {
    return { tone: 'warn', status: 'offline', note: 'offline' };
  }
  switch (link.connectionPath) {
    case 'local': {
      return { tone: 'good', status: 'home', note: 'seen' };
    }
    case 'relay': {
      return { tone: 'good', status: 'relay', note: 'seen' };
    }
    case 'wan':
    case 'ipv6': {
      return { tone: 'good', status: 'direct', note: 'seen' };
    }
    default: {
      return { tone: 'off', status: 'checking' };
    }
  }
};

/** A problem on this server stops every link, so the page says it once, at the top. */
export const householdsPause = (links: HouseholdLinkDto[], licensed: boolean | undefined) => {
  if (links.some((link) => link.paused && link.reason === 'unlinked')) {
    return 'cloud' as const;
  }
  if (licensed === false && links.some((link) => link.paused && link.reason === 'licence')) {
    return 'licence' as const;
  }
};

export type ReceivedStatus =
  'getting' | 'current' | 'offline' | 'full' | 'paused' | 'skipped_large' | 'skipped_other' | 'stopped';

/** The status line of a received space, from the share's state and its last machine word. */
export const receivedStatus = (share: HouseholdInboundShareDto): ReceivedStatus => {
  if (share.state === 'left') {
    return 'stopped';
  }
  switch (share.lastError) {
    case null: {
      return share.lastPulledAt ? 'current' : 'getting';
    }
    case 'over-quota': {
      return 'full';
    }
    case 'unreachable':
    case 'bad-page': {
      return 'offline';
    }
    case 'uploads-paused': {
      return 'paused';
    }
    case 'file-too-large': {
      return 'skipped_large';
    }
    // Caps on comments and people: every photo still arrived.
    case 'too-many-comments':
    case 'too-many-people': {
      return 'current';
    }
    default: {
      return share.lastPulledAt ? 'skipped_other' : 'getting';
    }
  }
};

/** A household invitation's notification names the inbound share it is about. */
export const householdInviteShareId = (data: unknown): string | undefined => {
  let value = data;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return;
    }
  }
  if (value && typeof value === 'object') {
    const { kind, inboundShareId } = value as { kind?: unknown; inboundShareId?: unknown };
    if (kind === 'household-share-invite' && typeof inboundShareId === 'string') {
      return inboundShareId;
    }
  }
};
