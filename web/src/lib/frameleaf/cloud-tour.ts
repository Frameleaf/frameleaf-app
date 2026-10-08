/**
 * FL-196 (CLD-008): the linked-server tour, ported from the owner-approved prototype
 * (design/frameleaf/template/src/cloud-tour.mjs, c4a009f8b5). A short, skippable sheet an
 * administrator lands on after this server is linked to Frameleaf Cloud outside first-run setup: what
 * the link unlocks, where each part stands on this server, and the settings page for each.
 *
 * Pure data and rules only; `CloudTour.svelte` draws it and `CloudTourHost.svelte` decides when it
 * opens. Whether an administrator has seen it is kept on the server (`GET/PUT admin/cloud/tour`).
 */
import type { LicenseSlotDto, LicenseStatusResponseDto } from '@frameleaf/sdk';
import {
  mdiAccountMultipleOutline,
  mdiBackupRestore,
  mdiCellphone,
  mdiCertificateOutline,
  mdiCloudCheckOutline,
  mdiCloudSyncOutline,
  mdiCloudUploadOutline,
  mdiContentDuplicate,
  mdiCreditCardOutline,
  mdiDns,
  mdiEarth,
  mdiHandBackRightOutline,
  mdiHomeOutline,
  mdiKeyOutline,
  mdiLightningBolt,
  mdiLinkVariant,
  mdiShieldAccountOutline,
  mdiTextBoxOutline,
  mdiTransitConnectionVariant,
  mdiViewDashboardOutline,
  mdiWalletOutline,
  mdiWeb,
} from '@mdi/js';
import type { Translations } from 'svelte-i18n';
import type { SettingsAreaId } from '$lib/frameleaf/settings-areas';

export type CloudTourStepId = 'remote' | 'address' | 'signin' | 'processing' | 'backup' | 'plan';

/** How a tour ended: finished, skipped (Skip tour or Escape), left for a settings page, or covered by setup. */
export const CLOUD_TOUR_ENDINGS = Object.freeze(['finished', 'skipped', 'opened-settings', 'setup'] as const);
export type CloudTourEnding = (typeof CLOUD_TOUR_ENDINGS)[number];

export type CloudTourPoint = { id: string; icon: string };
export type CloudTourLink = {
  id: string;
  area: SettingsAreaId;
  section?: string;
  /** Extra address parameters, for a page that is one view of an area (Backup's Cloud backup view). */
  params?: Record<string, string>;
};
/** The role colour of a step's icon tile (a token pair in cloud-tour.css), never a literal colour. */
export type CloudTourTile = 'blue' | 'teal' | 'accent' | 'ai' | 'neutral';
export type CloudTourStep = {
  id: CloudTourStepId;
  icon: string;
  /** The icon tile's role colour. Indigo is for the AI step only (BRAND.md decision 8). */
  tile: CloudTourTile;
  /** Carries the reserved AI mark (a sparkle on indigo). */
  ai?: boolean;
  points: readonly CloudTourPoint[];
  links: readonly CloudTourLink[];
};

/**
 * The six steps, in the prototype's order. Copy lives in `i18n/en.json` under
 * `frameleaf_cloud_tour_<step>_{title,summary}`, `frameleaf_cloud_tour_<step>_<point>_{title,text}`
 * and `frameleaf_cloud_tour_open_<link>`; each link opens a real settings page.
 */
export const cloudTourSteps: readonly CloudTourStep[] = Object.freeze([
  {
    id: 'remote',
    icon: mdiEarth,
    tile: 'blue',
    points: [
      { id: 'relay', icon: mdiTransitConnectionVariant },
      { id: 'direct', icon: mdiLightningBolt },
      { id: 'apps', icon: mdiCellphone },
    ],
    links: [{ id: 'remote', area: 'cloud', section: 'cloud-remote' }],
  },
  {
    id: 'address',
    icon: mdiWeb,
    tile: 'teal',
    points: [
      { id: 'frameleaf', icon: mdiLinkVariant },
      { id: 'domain', icon: mdiDns },
      { id: 'certificate', icon: mdiCertificateOutline },
    ],
    links: [{ id: 'addresses', area: 'cloud', section: 'cloud-remote' }],
  },
  {
    id: 'signin',
    icon: mdiShieldAccountOutline,
    tile: 'neutral',
    points: [
      { id: 'home', icon: mdiHomeOutline },
      { id: 'away', icon: mdiEarth },
      { id: 'each', icon: mdiAccountMultipleOutline },
    ],
    links: [{ id: 'signin', area: 'security', section: 'frameleaf-signin' }],
  },
  {
    id: 'processing',
    icon: mdiCloudSyncOutline,
    tile: 'ai',
    ai: true,
    points: [
      { id: 'jobs', icon: mdiTextBoxOutline },
      { id: 'wallet', icon: mdiWalletOutline },
      { id: 'asking', icon: mdiHandBackRightOutline },
    ],
    links: [{ id: 'processing', area: 'cloud', section: 'cloud-processing' }],
  },
  {
    id: 'backup',
    icon: mdiCloudUploadOutline,
    tile: 'accent',
    points: [
      { id: 'changed', icon: mdiContentDuplicate },
      { id: 'restore', icon: mdiBackupRestore },
      { id: 'key', icon: mdiKeyOutline },
    ],
    // Cloud backup is a view of the one Backup area (design review finding 66).
    links: [{ id: 'backup', area: 'backups', params: { backupView: 'cloud' } }],
  },
  {
    id: 'plan',
    icon: mdiCloudCheckOutline,
    tile: 'neutral',
    points: [
      { id: 'plan', icon: mdiCreditCardOutline },
      { id: 'license', icon: mdiCertificateOutline },
      { id: 'place', icon: mdiViewDashboardOutline },
    ],
    links: [
      { id: 'plan', area: 'cloud', section: 'cloud-plan' },
      { id: 'license', area: 'cloud', section: 'cloud-license' },
      { id: 'cloud', area: 'cloud' },
    ],
  },
] satisfies CloudTourStep[]);

export const stepKey = (step: CloudTourStepId, part: 'title' | 'summary') =>
  `frameleaf_cloud_tour_${step}_${part}` as Translations;
export const pointKey = (step: CloudTourStepId, point: string, part: 'title' | 'text') =>
  `frameleaf_cloud_tour_${step}_${point}_${part}` as Translations;
export const linkKey = (link: string) => `frameleaf_cloud_tour_open_${link}` as Translations;

/** Clamp a requested step (from `?tourStep=`, a dot or the keyboard) into range. */
export const clampTourStep = (value: unknown) => {
  const index = Math.trunc(Number(value));
  if (!Number.isFinite(index)) {
    return 0;
  }
  return Math.min(cloudTourSteps.length - 1, Math.max(0, index));
};

// ------------------------------------------------------------------ status chips

/**
 * What this server holds, from state already loaded: the link status and licence (the cloud
 * manager) and `GET admin/cloud/tour` (settings, the last AI Wallet read, the cloud backup record).
 */
export type CloudTourFacts = {
  license: Pick<LicenseStatusResponseDto, 'entitlements'> & {
    plan: Pick<LicenseSlotDto, 'state' | 'graceUntil'> | null;
  };
  remoteAccessEnabled: boolean;
  customHostnameVerified: boolean;
  processingEnabled: boolean;
  /** Balance less holds at the last wallet read; null when the wallet was never read. */
  walletAvailableUsd: number | null;
  backupConfigured: boolean;
};

export type CloudTourChipTone = 'ok' | 'muted' | 'warning';
export type CloudTourChip =
  | { kind: 'text'; key: Translations; tone: CloudTourChipTone }
  | { kind: 'credit'; on: boolean; usd: number; tone: CloudTourChipTone }
  | {
      kind: 'plan';
      state: 'none' | 'active' | 'grace' | 'expired' | 'invalid';
      graceUntil: string | null;
      licensed: boolean;
      tone: CloudTourChipTone;
    };

const text = (key: string, tone: CloudTourChipTone): CloudTourChip => ({
  kind: 'text',
  key: `frameleaf_cloud_tour_status_${key}` as Translations,
  tone,
});

/** The plan's state as the prototype's `licenseStatus` reads it; a lapsed grace period counts as expired. */
export const planState = (plan: CloudTourFacts['license']['plan'], now = Date.now()) => {
  if (!plan || plan.state === 'none') {
    return 'none';
  }
  if (plan.state === 'grace') {
    return plan.graceUntil && Date.parse(plan.graceUntil) > now ? 'grace' : 'expired';
  }
  return plan.state;
};

/** Cloud-connected features follow the plan; the grace period keeps them running. */
export const activeEntitlements = (license: CloudTourFacts['license'], now = Date.now()) => {
  const state = planState(license.plan, now);
  const cloud = state === 'active' || state === 'grace';
  return {
    remoteAccess: cloud && license.entitlements.remoteAccess,
    cloudBackup: cloud && license.entitlements.cloudBackup,
  };
};

/** Where each part stands right now, so the tour never promises what is not set up. */
export const cloudTourStatus = (step: CloudTourStepId, facts: CloudTourFacts, now = Date.now()): CloudTourChip => {
  const included = activeEntitlements(facts.license, now);
  const needsPlan = text('needs_plan', 'muted');
  switch (step) {
    case 'remote': {
      if (!included.remoteAccess) {
        return needsPlan;
      }
      return facts.remoteAccessEnabled ? text('on', 'ok') : text('ready_to_turn_on', 'muted');
    }
    case 'address': {
      if (!included.remoteAccess) {
        return needsPlan;
      }
      if (facts.customHostnameVerified) {
        return text('own_domain_verified', 'ok');
      }
      return facts.remoteAccessEnabled ? text('frameleaf_address_ready', 'ok') : text('ready_to_turn_on', 'muted');
    }
    case 'signin': {
      return text('available', 'ok');
    }
    case 'processing': {
      const tone = facts.processingEnabled ? 'ok' : 'muted';
      if (facts.walletAvailableUsd === null) {
        return text(facts.processingEnabled ? 'on' : 'off', tone);
      }
      return { kind: 'credit', on: facts.processingEnabled, usd: facts.walletAvailableUsd, tone };
    }
    case 'backup': {
      if (!included.cloudBackup) {
        return needsPlan;
      }
      return facts.backupConfigured ? text('on', 'ok') : text('ready_to_set_up', 'muted');
    }
    case 'plan': {
      const state = planState(facts.license.plan, now);
      return {
        kind: 'plan',
        state,
        graceUntil: facts.license.plan?.graceUntil ?? null,
        licensed: facts.license.entitlements.supporter,
        tone: state === 'active' ? 'ok' : state === 'none' ? 'muted' : 'warning',
      };
    }
  }
};

/** The lowest monthly plan price, for "from $6 a month"; null when no prices are loaded. */
export const lowestMonthlyPlanUsd = (products: ReadonlyArray<{ kind: string; period: string; priceUsd: number }>) => {
  const prices = products
    .filter((product) => product.kind === 'plan' && product.period === 'month')
    .map((product) => product.priceUsd);
  return prices.length > 0 ? Math.min(...prices) : null;
};

/** The step a review link asks for (`?tour=cloud&tourStep=N`), or null when none is asked for. */
export const requestedTourStep = (params: URLSearchParams) =>
  params.get('tour') === 'cloud' ? clampTourStep(params.get('tourStep')) : null;
