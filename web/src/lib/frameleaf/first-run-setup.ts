/**
 * Frameleaf first-run setup (FL-176): the two administrator flows — a new server, and the first
 * Frameleaf launch on an existing library — and the one-time personal account tool every other
 * account sees. The prototype's `design/frameleaf/template/src/first-run-setup.mjs` as typed, pure
 * state so the screens stay thin and the rules can be tested. Copy is i18n keys.
 *
 * Progress is saved on the server after every step (`PUT /system-metadata/frameleaf-setup`) once an
 * administrator exists, and in this browser before that. Passwords are never part of the state:
 * they travel as `secrets` and only reach the sign-up and login calls.
 */
import type { FrameleafSetupProgressDto, AdminConfigDto } from '@immich/sdk';
import type { Translations } from 'svelte-i18n';
import { passwordStrength } from '$lib/frameleaf/auth-password';

export const SETUP_KEY = 'frameleaf:setup:v1';
export const ACCOUNT_SETUP_KEY = 'frameleaf:account-setup:v1';

/** Setup always runs on the dark stage; the theme choice applies once it closes. */
export const SETUP_THEME = 'dark' as const;
export const setupStageTheme = () => SETUP_THEME;
export const themeAfterSetup = (choice: string | undefined) => (choice === 'light' ? 'light' : 'dark');

export type SetupFlow = 'new' | 'existing';
export type SetupChapterId = 'welcome' | 'account' | 'library' | 'protection' | 'ready';
export type SetupStepId =
  | 'welcome'
  | 'sign-in-choice'
  | 'account'
  | 'admin-sign-in'
  | 'library'
  | 'library-check'
  | 'processing'
  | 'protection'
  | 'privacy'
  | 'people'
  | 'imports'
  | 'ready';

export type SetupStep = { id: SetupStepId; chapter: SetupChapterId; title: Translations; required?: boolean };

export const setupChapters: readonly { id: SetupChapterId; label: Translations }[] = [
  { id: 'welcome', label: 'frameleaf_setup_chapter_welcome' },
  { id: 'account', label: 'frameleaf_setup_chapter_account' },
  { id: 'library', label: 'frameleaf_setup_chapter_library' },
  { id: 'protection', label: 'frameleaf_setup_chapter_protection' },
  { id: 'ready', label: 'frameleaf_setup_chapter_ready' },
];

const step = (id: SetupStepId, chapter: SetupChapterId, title: Translations, required = false): SetupStep =>
  required ? { id, chapter, title, required } : { id, chapter, title };

export const setupFlows: Record<SetupFlow, readonly SetupStep[]> = {
  new: [
    step('welcome', 'welcome', 'frameleaf_setup_welcome_title'),
    step('sign-in-choice', 'account', 'frameleaf_setup_sign_in_choice_title'),
    step('account', 'account', 'frameleaf_setup_account_title', true),
    step('library', 'library', 'frameleaf_setup_library_title', true),
    step('processing', 'library', 'frameleaf_setup_processing_title'),
    step('protection', 'protection', 'frameleaf_setup_protection_title'),
    step('privacy', 'protection', 'frameleaf_setup_privacy_title'),
    step('imports', 'ready', 'frameleaf_setup_imports_title'),
    step('ready', 'ready', 'frameleaf_setup_ready_title'),
  ],
  existing: [
    step('admin-sign-in', 'welcome', 'frameleaf_setup_gate_title', true),
    step('welcome', 'welcome', 'frameleaf_setup_safe_title'),
    step('account', 'account', 'frameleaf_setup_account_title'),
    step('library-check', 'library', 'frameleaf_setup_library_check_title'),
    step('processing', 'library', 'frameleaf_setup_processing_title'),
    step('protection', 'protection', 'frameleaf_setup_protection_title'),
    step('privacy', 'protection', 'frameleaf_setup_privacy_title'),
    step('people', 'ready', 'frameleaf_setup_people_title'),
    step('imports', 'ready', 'frameleaf_setup_imports_title'),
    step('ready', 'ready', 'frameleaf_setup_ready_title'),
  ],
};

export const flowSteps = (flow: SetupFlow) => setupFlows[flow] ?? setupFlows.new;
export const chapterIndex = (chapterId: SetupChapterId) =>
  Math.max(
    0,
    setupChapters.findIndex((chapter) => chapter.id === chapterId),
  );

// --------------------------------------------------------------- choices

export type ModelTier = 'light' | 'balanced' | 'best';
export type ProcessingChoice = 'local' | 'cloud' | 'later';

/** The CLIP model each tier uses; a model outside the list reads as the recommended tier. */
export const modelTiers: readonly {
  id: ModelTier;
  label: Translations;
  summary: Translations;
  model: string;
  speed: number;
  recommended?: boolean;
}[] = [
  {
    id: 'light',
    label: 'frameleaf_setup_tier_light',
    summary: 'frameleaf_setup_tier_light_summary',
    model: 'ViT-B-32__openai',
    speed: 1.6,
  },
  {
    id: 'balanced',
    label: 'frameleaf_setup_tier_balanced',
    summary: 'frameleaf_setup_tier_balanced_summary',
    model: 'ViT-B-16-SigLIP2__webli',
    speed: 1,
    recommended: true,
  },
  {
    id: 'best',
    label: 'frameleaf_setup_tier_best',
    summary: 'frameleaf_setup_tier_best_summary',
    model: 'ViT-SO400M-16-SigLIP2-384__webli',
    speed: 0.5,
  },
];

export const KEEP_LAYOUT = 'keep';
export const layoutPresets: readonly { id: string; label: Translations; pattern: string; recommended?: boolean }[] = [
  {
    id: 'year-month',
    label: 'frameleaf_setup_layout_year_month',
    pattern: '{{y}}/{{MM}}/{{filename}}',
    recommended: true,
  },
  { id: 'date', label: 'frameleaf_setup_layout_date', pattern: '{{y}}/{{y}}-{{MM}}-{{dd}}/{{filename}}' },
  { id: 'album', label: 'frameleaf_setup_layout_album', pattern: '{{album}}/{{y}}/{{filename}}' },
  { id: 'camera', label: 'frameleaf_setup_layout_camera', pattern: '{{make}} {{model}}/{{y}}/{{filename}}' },
];
export const layoutPattern = (layout: string, current: string) =>
  layout === KEEP_LAYOUT ? current : (layoutPresets.find((entry) => entry.id === layout) ?? layoutPresets[0]).pattern;

export type SetupChoices = {
  language: string;
  signIn: 'frameleaf' | 'local';
  linked: boolean;
  /** Set once the local administrator exists; never the password. */
  accountCreated: boolean;
  /** Set once the administrator signed in (existing library). */
  signedIn: boolean;
  restore: 'restore' | 'fresh' | null;
  adminName: string;
  adminEmail: string;
  layout: string;
  model: ModelTier;
  processing: ProcessingChoice;
  nightlyBackup: boolean;
  updates: boolean;
  map: boolean;
  theme: 'dark' | 'light';
};

export type SetupState = {
  version: 1;
  flow: SetupFlow;
  step: number;
  reached: number;
  completed: boolean;
  choices: SetupChoices;
};

/** What the screens know that isn't saved: the live storage check. */
export type SetupContext = { secrets?: { password?: string; confirm?: string }; storageWritable?: boolean | null };

export const createSetup = (flow: SetupFlow = 'new'): SetupState => {
  const existing = flow === 'existing';
  return {
    version: 1,
    flow: existing ? 'existing' : 'new',
    step: 0,
    reached: 0,
    completed: false,
    choices: {
      language: 'en',
      // New servers recommend a Frameleaf account; existing ones keep the local admin.
      signIn: existing ? 'local' : 'frameleaf',
      linked: false,
      accountCreated: false,
      signedIn: false,
      restore: null,
      adminName: '',
      adminEmail: '',
      layout: existing ? KEEP_LAYOUT : 'year-month',
      model: 'balanced',
      processing: 'local',
      nightlyBackup: true,
      updates: true,
      map: true,
      theme: 'dark',
    },
  };
};

const bool = (value: unknown, fallback: boolean) => (typeof value === 'boolean' ? value : fallback);
const oneOf = <T extends string>(value: unknown, list: readonly T[], fallback: T): T =>
  list.includes(value as T) ? (value as T) : fallback;
const text = (value: unknown, max = 120) => (typeof value === 'string' ? value.slice(0, max) : '');
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const EMAIL = /^[^\s@]+@[^\s@]+$/;
export const validEmail = (value: string) => EMAIL.test(value.trim());

/**
 * What still blocks a step. Only the account (the administrator) and a writable library location
 * are required; every other step has a recommended choice.
 */
export const validateStep = (state: SetupState, stepId: SetupStepId, context: SetupContext = {}) => {
  const errors: Partial<Record<'link' | 'name' | 'email' | 'password' | 'confirm' | 'storage', Translations>> = {};
  const { choices } = state;
  const secrets = context.secrets ?? {};
  if (stepId === 'account' && state.flow === 'new') {
    if (choices.signIn === 'frameleaf') {
      if (!choices.linked) {
        errors.link = 'frameleaf_setup_error_link';
      }
    } else if (!choices.accountCreated) {
      if (!choices.adminName.trim()) {
        errors.name = 'frameleaf_setup_error_name';
      }
      if (!validEmail(choices.adminEmail)) {
        errors.email = 'frameleaf_setup_error_email';
      }
      if (!passwordStrength(secrets.password ?? '').recommended) {
        errors.password = 'frameleaf_setup_error_password';
      } else if (secrets.password !== secrets.confirm) {
        errors.confirm = 'frameleaf_setup_error_confirm';
      }
    }
  }
  if (stepId === 'library' && context.storageWritable === false) {
    errors.storage = 'frameleaf_setup_error_storage';
  }
  if (stepId === 'admin-sign-in' && !choices.signedIn && !String(secrets.password ?? '').trim()) {
    errors.password = 'frameleaf_setup_error_sign_in';
  }
  return { ok: Object.keys(errors).length === 0, errors };
};

/**
 * The first required step before `upTo` (every step when omitted) that doesn't validate without
 * secrets, or -1. Used on resume and before finishing.
 */
export const firstInvalidStep = (state: SetupState, upTo = Infinity, context: SetupContext = {}) =>
  flowSteps(state.flow).findIndex(
    (entry, index) => index < upTo && entry.required && !validateStep(state, entry.id, { ...context, secrets: {} }).ok,
  );

/** Moves to a step; forward moves are only allowed past valid steps. */
export const goToStep = (state: SetupState, target: number, context: SetupContext = {}): SetupState => {
  const steps = flowSteps(state.flow);
  const next = Math.min(steps.length - 1, Math.max(0, target));
  if (next > state.step) {
    for (let index = state.step; index < next; index += 1) {
      if (!validateStep(state, steps[index].id, context).ok) {
        return state;
      }
    }
  }
  const passed = new Set(steps.slice(0, next).map((entry) => entry.id));
  const choices = { ...state.choices };
  if (passed.has('account') && state.flow === 'new' && choices.signIn === 'local') {
    choices.accountCreated = true;
  }
  if (passed.has('admin-sign-in')) {
    choices.signedIn = true;
  }
  return { ...state, choices, step: next, reached: Math.max(state.reached, next) };
};

/** Links or unlinks the server; unlinking drops the choices that need Frameleaf. */
export const setLinked = (state: SetupState, linked: boolean): SetupState => {
  const choices = { ...state.choices, linked };
  if (!linked) {
    if (choices.processing === 'cloud') {
      choices.processing = 'local';
    }
    choices.restore = null;
  }
  return { ...state, choices };
};

/** Where processing can run: the Cloud option only shows when the server is already linked. */
export const processingOptions = (state: SetupState): ProcessingChoice[] => [
  'local',
  ...(state.choices.linked ? (['cloud'] as const) : []),
  ...(state.flow === 'existing' ? (['later'] as const) : []),
];

// ---------------------------------------------------------- saved progress

/** The server's password-free progress payload for this state. */
export const toProgress = (state: SetupState): FrameleafSetupProgressDto => {
  const { restore, ...choices } = state.choices;
  return {
    version: 1,
    step: flowSteps(state.flow)[state.step].id,
    reached: state.reached,
    choices: { ...choices, ...(restore ? { restore } : {}) } as FrameleafSetupProgressDto['choices'],
  };
};

/** Validates saved progress for a flow; anything unexpected falls back to the default. */
export const parseSetup = (raw: unknown, flow: SetupFlow, context: SetupContext = {}): SetupState | null => {
  let source: unknown = raw;
  if (typeof raw === 'string') {
    try {
      source = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!isRecord(source) || source.version !== 1) {
    return null;
  }
  if (source.flow !== undefined && source.flow !== flow) {
    return null;
  }
  const base = createSetup(flow);
  const steps = flowSteps(flow);
  const last = steps.length - 1;
  const indexOf = (value: unknown) => {
    if (typeof value === 'string') {
      const found = steps.findIndex((entry) => entry.id === value);
      return found < 0 ? 0 : found;
    }
    return Number.isInteger(value) ? Math.min(last, Math.max(0, value as number)) : 0;
  };
  const choices = isRecord(source.choices) ? source.choices : {};
  const defaults = base.choices;
  const at = indexOf(source.step);
  const reached = Math.max(indexOf(source.reached), at);
  const parsed: SetupState = {
    ...base,
    step: at,
    reached,
    completed: source.completed === true,
    choices: {
      language: text(choices.language, 12) || defaults.language,
      signIn: oneOf(choices.signIn, ['frameleaf', 'local'] as const, defaults.signIn),
      linked: bool(choices.linked, false),
      accountCreated: bool(choices.accountCreated, false),
      signedIn: bool(choices.signedIn, false),
      restore: choices.restore === 'restore' || choices.restore === 'fresh' ? choices.restore : null,
      adminName: text(choices.adminName),
      adminEmail: text(choices.adminEmail),
      layout: oneOf(choices.layout, [KEEP_LAYOUT, ...layoutPresets.map((entry) => entry.id)], defaults.layout),
      model: oneOf(
        choices.model,
        modelTiers.map((entry) => entry.id),
        defaults.model,
      ),
      processing: oneOf(choices.processing, ['local', 'cloud', 'later'] as const, defaults.processing),
      nightlyBackup: bool(choices.nightlyBackup, true),
      updates: bool(choices.updates, true),
      map: bool(choices.map, true),
      theme: oneOf(choices.theme, ['dark', 'light'] as const, 'dark'),
    },
  };
  // Resume never lands past a required step that no longer checks out.
  const invalid = firstInvalidStep(parsed, parsed.step, context);
  return invalid < 0 ? parsed : { ...parsed, step: invalid, completed: false };
};

/**
 * Where setup resumes: the server's saved progress, else this browser's copy, else the start. A
 * signed-in administrator is past the account and sign-in steps whatever the saved copy says.
 */
export const resumeSetup = (
  flow: SetupFlow,
  saved: { server?: FrameleafSetupProgressDto | null; local?: SetupState | null },
  signedIn: boolean,
): SetupState => {
  // A signed-in administrator exists and has signed in, whatever the saved copy recorded.
  const signedInChoices = signedIn ? (flow === 'existing' ? { signedIn: true } : { accountCreated: true }) : {};
  const patch = (source: { choices?: object } & Record<string, unknown>) => ({
    ...source,
    flow,
    choices: { ...source.choices, ...signedInChoices },
  });
  const fromServer = saved.server ? parseSetup(patch(saved.server), flow) : null;
  const fromLocal = saved.local?.flow === flow ? parseSetup(patch({ ...saved.local }), flow) : null;
  const state = fromServer ?? fromLocal ?? parseSetup(patch({ ...createSetup(flow) }), flow) ?? createSetup(flow);
  if (!signedIn) {
    return state;
  }
  const choices = { ...state.choices };
  if (flow === 'new' && choices.signIn === 'frameleaf' && !choices.linked) {
    choices.signIn = 'local';
  }
  const step = flow === 'existing' ? Math.max(1, state.step) : state.step;
  return { ...state, choices, step, reached: Math.max(state.reached, step) };
};

type KeyValueStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const browserStorage = (): KeyValueStore | undefined => globalThis.localStorage;

/** This browser's copy, used before an administrator exists (and as a fallback). */
export const loadLocalSetup = (flow: SetupFlow, storage = browserStorage()) => {
  try {
    return parseSetup(storage?.getItem(SETUP_KEY) ?? null, flow);
  } catch {
    return null;
  }
};
export const saveLocalSetup = (state: SetupState, storage = browserStorage()) => {
  try {
    storage?.setItem(SETUP_KEY, JSON.stringify({ ...state, ...toProgress(state), flow: state.flow }));
    return true;
  } catch {
    return false;
  }
};
export const clearLocalSetup = (storage = browserStorage()) => {
  try {
    storage?.removeItem(SETUP_KEY);
  } catch {
    // private windows can refuse storage; the server copy still resumes
  }
};

// ----------------------------------------------------------- estimates

export const TB = 1e12;
export const formatTb = (bytes: number) => `${(Math.max(0, Number(bytes) || 0) / TB).toFixed(1)} TB`;

/** Items an hour this hardware indexes at the recommended tier. */
export const itemsPerHour = (gpu: boolean, embeddingMs?: number | null) =>
  embeddingMs && embeddingMs > 0 ? Math.max(300, Math.round(3_600_000 / (embeddingMs * 4))) : gpu ? 5400 : 1200;

/** Hours to re-index a library locally at the chosen model tier. */
export const reindexHours = (items: number, tierId: ModelTier, perHour: number) => {
  const tier = modelTiers.find((entry) => entry.id === tierId) ?? modelTiers[1];
  const rate = Math.max(1, perHour * tier.speed);
  return Math.max(1, Math.round(Math.max(0, Number(items) || 0) / rate));
};

export const tierForModel = (modelName: string | undefined): ModelTier | null =>
  modelTiers.find((entry) => entry.model === modelName)?.id ?? null;

// ------------------------------------------------------ applying choices

/**
 * The settings the finished setup writes. Nothing changes for a choice the administrator left at
 * "keep" or "decide later": the existing layout and the current models stay as they are.
 */
export const applySetupChoices = (config: AdminConfigDto, state: SetupState): AdminConfigDto => {
  const { choices } = state;
  const next = structuredClone(config);
  if (choices.layout !== KEEP_LAYOUT) {
    next.storageTemplate.enabled = true;
    next.storageTemplate.template = layoutPattern(choices.layout, config.storageTemplate.template);
  }
  if (choices.processing !== 'later') {
    const tier = modelTiers.find((entry) => entry.id === choices.model);
    if (tier) {
      next.machineLearning.clip.modelName = tier.model;
    }
  }
  next.backup.database.enabled = choices.nightlyBackup;
  next.newVersionCheck.enabled = choices.updates;
  next.map.enabled = choices.map;
  return next;
};

/** Whether finishing re-indexes the library: the model changes and processing isn't deferred. */
export const needsReindex = (config: AdminConfigDto, state: SetupState) =>
  state.flow === 'existing' &&
  state.choices.processing !== 'later' &&
  applySetupChoices(config, state).machineLearning.clip.modelName !== config.machineLearning.clip.modelName;

// -------------------------------------------------------- route guard

/**
 * FL-176: while setup is incomplete an administrator is sent to it from every signed-in page;
 * other accounts keep using the library.
 */
export const setupRedirect = (
  pathname: string,
  user: { isAdmin: boolean } | undefined,
  server: { isInitialized: boolean; isOnboarded: boolean },
) => {
  if (!user?.isAdmin || !server.isInitialized || server.isOnboarded) {
    return null;
  }
  if (pathname.startsWith('/auth/') || pathname.startsWith('/maintenance') || pathname.startsWith('/link')) {
    return null;
  }
  return '/auth/onboarding';
};

// -------------------------------------------------- personal account tool

export type AccountSectionId = 'profile' | 'appearance' | 'privacy' | 'mobile' | 'frameleaf';
export const accountToolSections: readonly { id: AccountSectionId; title: Translations }[] = [
  { id: 'profile', title: 'frameleaf_setup_tool_profile' },
  { id: 'appearance', title: 'frameleaf_setup_tool_appearance' },
  { id: 'privacy', title: 'frameleaf_setup_tool_privacy' },
  { id: 'mobile', title: 'frameleaf_setup_tool_mobile' },
  { id: 'frameleaf', title: 'frameleaf_setup_tool_frameleaf' },
];

export type AccountToolState = { version: 1; done: AccountSectionId[] };

export const createAccountTool = (): AccountToolState => ({ version: 1, done: [] });
export const parseAccountTool = (raw: unknown): AccountToolState | null => {
  let source: unknown = raw;
  if (typeof raw === 'string') {
    try {
      source = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!isRecord(source) || source.version !== 1) {
    return null;
  }
  const ids = accountToolSections.map((entry) => entry.id);
  const done = Array.isArray(source.done) ? source.done.filter((id): id is AccountSectionId => ids.includes(id)) : [];
  return { version: 1, done: [...new Set(done)] };
};
const accountKey = (userId: string) => `${ACCOUNT_SETUP_KEY}:${userId}`;
export const loadAccountTool = (userId: string, storage = browserStorage()) => {
  try {
    return parseAccountTool(storage?.getItem(accountKey(userId)) ?? null) ?? createAccountTool();
  } catch {
    return createAccountTool();
  }
};
export const saveAccountTool = (userId: string, state: AccountToolState, storage = browserStorage()) => {
  try {
    storage?.setItem(accountKey(userId), JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
};
export const markSection = (state: AccountToolState, id: AccountSectionId): AccountToolState =>
  state.done.includes(id) ? state : { ...state, done: [...state.done, id] };
export const accountToolProgress = (state: AccountToolState) => ({
  done: state.done.length,
  total: accountToolSections.length,
});
