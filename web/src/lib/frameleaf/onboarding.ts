/**
 * First-run onboarding (FL-75/FL-80 ON-1, O-1…O-12): the September 22 prototype's step set and
 * helpers (`design/frameleaf/template/src/system-data.mjs:490-646`, `AuthScreens.jsx:818-1273`),
 * adapted to production — steps carry the role that sees them (server setup only for an
 * administrator of a server that is not yet onboarded), the storage template preview uses the
 * server's own variables, and the step reached is remembered per account so "Finish later"
 * resumes where it stopped.
 */
import type { Translations } from 'svelte-i18n';
import { OnboardingRole } from '$lib/types';

export type OnboardingStepId =
  | 'hello'
  | 'language'
  | 'theme'
  | 'server_privacy'
  | 'user_privacy'
  | 'storage_template'
  | 'frameleaf_account'
  | 'license'
  | 'backup'
  | 'mobile_app'
  | 'done';

export type OnboardingStep = {
  id: OnboardingStepId;
  role: OnboardingRole;
  /** The step's heading. */
  title: Translations;
  /** The short name in the step rail. */
  short: Translations;
};

/**
 * Prototype order: Welcome → Language → Theme → Server privacy → Your privacy → Storage → Frameleaf
 * account → Plan & licence → Backup → Mobile app → Done (11 steps for the first administrator).
 */
export const ONBOARDING_STEPS: readonly OnboardingStep[] = [
  {
    id: 'hello',
    role: OnboardingRole.USER,
    title: 'frameleaf_onboarding_hello_title',
    short: 'frameleaf_onboarding_hello_short',
  },
  { id: 'language', role: OnboardingRole.USER, title: 'frameleaf_onboarding_language_title', short: 'language' },
  { id: 'theme', role: OnboardingRole.USER, title: 'frameleaf_onboarding_theme_title', short: 'theme' },
  { id: 'server_privacy', role: OnboardingRole.SERVER, title: 'server_privacy', short: 'server_privacy' },
  {
    id: 'user_privacy',
    role: OnboardingRole.USER,
    title: 'frameleaf_onboarding_user_privacy_title',
    short: 'frameleaf_onboarding_user_privacy_title',
  },
  {
    id: 'storage_template',
    role: OnboardingRole.SERVER,
    title: 'frameleaf_onboarding_storage_title',
    short: 'frameleaf_onboarding_storage_short',
  },
  // FL-158 / FL-157: optional server steps after Storage (AuthScreens.jsx:1219-1352, system-data.mjs:500-501)
  {
    id: 'frameleaf_account',
    role: OnboardingRole.SERVER,
    title: 'frameleaf_onboarding_account_title',
    short: 'frameleaf_onboarding_account_short',
  },
  {
    id: 'license',
    role: OnboardingRole.SERVER,
    title: 'frameleaf_onboarding_license_title',
    short: 'frameleaf_onboarding_license_short',
  },
  {
    id: 'backup',
    role: OnboardingRole.USER,
    title: 'frameleaf_onboarding_backup_title',
    short: 'frameleaf_onboarding_backup_short',
  },
  { id: 'mobile_app', role: OnboardingRole.USER, title: 'frameleaf_onboarding_mobile_title', short: 'mobile_app' },
  { id: 'done', role: OnboardingRole.USER, title: 'frameleaf_onboarding_done_title', short: 'done' },
];

export const onboardingStepsFor = (role: OnboardingRole) =>
  ONBOARDING_STEPS.filter((step) => step.role === OnboardingRole.USER || role === OnboardingRole.SERVER);

export const onboardingStepIndex = (steps: readonly OnboardingStep[], id: string | null | undefined) =>
  Math.max(
    0,
    steps.findIndex((step) => step.id === id),
  );

// ------------------------------------------------------------------ saved progress

const PROGRESS_KEY = 'frameleaf:onboarding:v1';

export type OnboardingProgress = { step: OnboardingStepId; reached: number };

const storage = () => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

/** The step this account stopped on and the furthest step it reached, or null when nothing was saved. */
export const loadOnboardingProgress = (userId: string): OnboardingProgress | null => {
  try {
    const raw = storage()?.getItem(`${PROGRESS_KEY}:${userId}`);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    const { step, reached } = parsed as Record<string, unknown>;
    if (ONBOARDING_STEPS.every(({ id }) => id !== step) || !Number.isSafeInteger(reached)) {
      return null;
    }
    return { step: step as OnboardingStepId, reached: Math.max(0, reached as number) };
  } catch {
    return null;
  }
};

export const saveOnboardingProgress = (userId: string, progress: OnboardingProgress) => {
  try {
    storage()?.setItem(`${PROGRESS_KEY}:${userId}`, JSON.stringify(progress));
  } catch {
    // Device storage is optional: onboarding still works, it just starts over next time.
  }
};

export const clearOnboardingProgress = (userId: string) => {
  try {
    storage()?.removeItem(`${PROGRESS_KEY}:${userId}`);
  } catch {
    // As above.
  }
};

// ------------------------------------------------------------------ storage template

/** The prototype's sample asset (system-data.mjs:519-540), used for the live example. */
const SAMPLE: Record<string, string> = {
  y: '2026',
  yy: '26',
  MMMM: 'September',
  MMM: 'Sep',
  MM: '09',
  M: '9',
  dd: '14',
  d: '14',
  hh: '16',
  mm: '42',
  ss: '07',
  filename: 'IMG_4021',
  filetype: 'IMG',
  filetypefull: 'IMAGE',
  assetId: '6f1c2a9e-1d4b-4a6e-9c1f-0b7e2d9a4c31',
  assetIdShort: '0b7e2d9a4c31',
  album: 'Summer in the Rockies',
  make: 'Apple',
  model: 'iPhone 16 Pro',
  lensModel: 'iPhone 16 Pro back camera',
};

export const STORAGE_TEMPLATE_MAX_LENGTH = 200;

export const STORAGE_TEMPLATE_VARIABLES: readonly { token: string; label: Translations }[] = [
  { token: '{{y}}', label: 'frameleaf_onboarding_variable_year' },
  { token: '{{MM}}', label: 'frameleaf_onboarding_variable_month' },
  { token: '{{MMM}}', label: 'frameleaf_onboarding_variable_month_name' },
  { token: '{{dd}}', label: 'frameleaf_onboarding_variable_day' },
  { token: '{{filename}}', label: 'frameleaf_onboarding_variable_filename' },
  { token: '{{album}}', label: 'frameleaf_onboarding_variable_album' },
  { token: '{{filetype}}', label: 'frameleaf_onboarding_variable_filetype' },
  { token: '{{make}}', label: 'frameleaf_onboarding_variable_make' },
  { token: '{{model}}', label: 'frameleaf_onboarding_variable_model' },
  { token: '{{assetId}}', label: 'frameleaf_onboarding_variable_asset_id' },
];

export const STORAGE_TEMPLATE_PRESETS: readonly { id: string; label: Translations; pattern: string }[] = [
  { id: 'date', label: 'frameleaf_onboarding_preset_date', pattern: '{{y}}/{{y}}-{{MM}}-{{dd}}/{{filename}}' },
  { id: 'month', label: 'frameleaf_onboarding_preset_month', pattern: '{{y}}/{{MMM}}/{{filename}}' },
  { id: 'album', label: 'frameleaf_onboarding_preset_album', pattern: '{{album}}/{{y}}/{{filename}}' },
  { id: 'camera', label: 'frameleaf_onboarding_preset_camera', pattern: '{{make}} {{model}}/{{y}}/{{filename}}' },
];

/**
 * Expands a storage template against the sample asset (the prototype's `renderStorageTemplate`) for
 * the live example. The server supports more than the sample knows (`{{#if album}}` blocks, album
 * dates, lens model…), so a token the sample cannot fill only means there is no example for it: the
 * pattern is still saved and the server validates it. `previewable` is false in that case.
 */
export const renderStorageTemplate = (pattern: string, storageLabel: string) => {
  const unknown: string[] = [];
  const source = pattern.slice(0, STORAGE_TEMPLATE_MAX_LENGTH);
  const body = source.replaceAll(/{{\s*([^{}]*?)\s*}}/g, (match, key: string) => {
    if (Object.hasOwn(SAMPLE, key)) {
      return SAMPLE[key];
    }
    unknown.push(key);
    return match;
  });
  const clean = body
    .replaceAll(/\/+/g, '/')
    .replaceAll(/^\/|\/$/g, '')
    .trim();
  return { path: `library/${storageLabel}/${clean || '…'}.jpg`, unknown, previewable: unknown.length === 0 };
};

/** Inserts `token` over the selection of `pattern`, returning the new pattern and caret. */
export const insertStorageToken = (pattern: string, token: string, start = pattern.length, end = start) => {
  const next = (pattern.slice(0, start) + token + pattern.slice(end)).slice(0, STORAGE_TEMPLATE_MAX_LENGTH);
  return { pattern: next, caret: Math.min(start + token.length, next.length) };
};
