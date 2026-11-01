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
import type { FrameleafSetupProgressDto, AdminConfigDto } from '@frameleaf/sdk';
import { CloudAccountLinkRefusal } from '@frameleaf/sdk';
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
  | 'account'
  | 'frameleaf-account'
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
    // FL-708 (UI review item 20): the administrator is always a local account, so the owner can sign in
    // to their own server even when Frameleaf Cloud can't be reached. A Frameleaf account comes next
    // and can be skipped.
    step('account', 'account', 'frameleaf_setup_admin_account_title', true),
    step('frameleaf-account', 'account', 'frameleaf_setup_frameleaf_account_title'),
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

/**
 * FL-708 (item 2): the step counter counts the chapters the rail shows ("Account · 2 of 5"), not the
 * steps inside them.
 */
export const chapterCount = (chapterId: SetupChapterId) => ({
  chapter: setupChapters[chapterIndex(chapterId)].label,
  position: chapterIndex(chapterId) + 1,
  count: setupChapters.length,
});

/**
 * FL-708 (item 4): the "Required" badge shows only where there is something to fill in: the new
 * server's administrator form. The library location is required to be writable, but it can't be
 * edited in setup, so it carries no badge.
 */
export const showsRequired = (state: SetupState, stepId: SetupStepId) =>
  stepId === 'account' && state.flow === 'new' && !state.choices.accountCreated;

// --------------------------------------------------------------- choices

export type ModelTier = 'light' | 'balanced' | 'best';
/** An existing library's search model outside the tiers, left as it is (owner decision, FL-722). */
export const KEEP_MODEL = 'keep' as const;
export type ModelChoice = ModelTier | typeof KEEP_MODEL;
export type ProcessingChoice = 'local' | 'cloud' | 'later';

/**
 * The search (CLIP) and face models each tier uses; a model outside the list reads as the default
 * tier. Which tier is recommended follows the hardware (`recommendedTier`), not the list.
 */
export const modelTiers: readonly {
  id: ModelTier;
  label: Translations;
  summary: Translations;
  model: string;
  face: string;
  speed: number;
}[] = [
  {
    id: 'light',
    label: 'frameleaf_setup_tier_light',
    summary: 'frameleaf_setup_tier_light_summary',
    model: 'ViT-B-32__openai',
    face: 'buffalo_s',
    speed: 1.6,
  },
  {
    id: 'balanced',
    label: 'frameleaf_setup_tier_balanced',
    summary: 'frameleaf_setup_tier_balanced_summary',
    // The server's default models (config.dto), which the image stages: choosing it downloads nothing.
    model: 'ViT-B-16-SigLIP-384__webli',
    face: 'buffalo_l',
    speed: 1,
  },
  {
    id: 'best',
    label: 'frameleaf_setup_tier_best',
    summary: 'frameleaf_setup_tier_best_summary',
    model: 'ViT-SO400M-16-SigLIP2-384__webli',
    face: 'antelopev2',
    speed: 0.5,
  },
];

/** The tier a server with no hardware check yet, or an unknown library model, starts from. */
export const DEFAULT_TIER: ModelTier = 'balanced';

/** What the tier recommendation reads from the hardware check (`HardwareCheckResponseDto.ml`). */
export type TierHardware = {
  ml: { reachable: boolean; backend: string; vramGb: number | null; integrated: boolean | null };
};

/**
 * The tier this hardware is recommended (A2): a processor or an integrated GPU runs the light models
 * at a usable speed; a graphics card with 6 GB or more of its own memory runs the balanced ones; one
 * with 12 GB or more runs the best. Unknown hardware, an unreachable ML container or a card whose
 * memory the check could not read reads as balanced, the server's own default.
 */
export const recommendedTier = (check: TierHardware | null | undefined): ModelTier => {
  const ml = check?.ml;
  if (!ml || !ml.reachable) {
    return DEFAULT_TIER;
  }
  if (ml.backend === 'CPU' || ml.integrated) {
    return 'light';
  }
  if (ml.vramGb === null || !Number.isFinite(ml.vramGb)) {
    return DEFAULT_TIER;
  }
  if (ml.vramGb >= 12) {
    return 'best';
  }
  return ml.vramGb >= 6 ? 'balanced' : 'light';
};

/** Whether an existing library's search model is one outside the tiers, offered as "keep current model". */
export const keepsUnlistedModel = (flow: SetupFlow, currentModel: string | null | undefined) =>
  flow === 'existing' && !!currentModel && tierForModel(currentModel) === null;

/**
 * The tier setup starts from once the server has answered: on a new server the hardware's recommended
 * tier; on an existing library the tier of the model it already uses, or "keep current model" for a
 * model outside the tiers, so finishing never switches its models and re-embeds it unless the
 * administrator chose to.
 */
export const defaultTier = (
  flow: SetupFlow,
  { hardware, currentModel }: { hardware?: TierHardware | null; currentModel?: string | null },
): ModelChoice => {
  if (flow !== 'existing') {
    return recommendedTier(hardware);
  }
  if (keepsUnlistedModel(flow, currentModel)) {
    return KEEP_MODEL;
  }
  return tierForModel(currentModel ?? undefined) ?? DEFAULT_TIER;
};

/**
 * Applies the default tier to a setup the administrator has not taken a tier decision in yet: the
 * tier step (`processing`) is not reached. A tier chosen there (`modelChosen`), or saved progress
 * past it, stays; except that progress which never recorded a choice (older saves held the default
 * tier) offers "keep current model" again for a library on a model outside the tiers.
 */
export const withDefaultTier = (
  state: SetupState,
  context: { hardware?: TierHardware | null; currentModel?: string | null },
): SetupState => {
  if (state.choices.modelChosen) {
    return state;
  }
  const tierStep = flowSteps(state.flow).findIndex((entry) => entry.id === 'processing');
  const pastTier = tierStep === -1 || state.reached >= tierStep;
  if (pastTier && !keepsUnlistedModel(state.flow, context.currentModel)) {
    return state;
  }
  const model = defaultTier(state.flow, context);
  const keptModel = model === KEEP_MODEL ? (context.currentModel ?? '') : '';
  return model === state.choices.model && keptModel === state.choices.keptModel
    ? state
    : { ...state, choices: { ...state.choices, model, keptModel } };
};

/**
 * "Keep current model" keeps the model the administrator saw. When the library's model changed while
 * setup was closed, the choice is taken again: the tier this model defaults to, with setup back on the
 * tier step so the administrator confirms it. Saves made before the model was recorded keep their choice.
 */
export const reconcileKeptModel = (
  state: SetupState,
  context: { hardware?: TierHardware | null; currentModel?: string | null },
): SetupState => {
  const { model, keptModel } = state.choices;
  if (model !== KEEP_MODEL || !keptModel || keptModel === (context.currentModel ?? '')) {
    return state;
  }
  const tierStep = flowSteps(state.flow).findIndex((entry) => entry.id === 'processing');
  const next = defaultTier(state.flow, context);
  return {
    ...state,
    step: tierStep === -1 ? state.step : Math.min(state.step, tierStep),
    completed: false,
    choices: {
      ...state.choices,
      model: next,
      modelChosen: false,
      keptModel: next === KEEP_MODEL ? (context.currentModel ?? '') : '',
    },
  };
};

const tierStepOf = (flow: SetupFlow) => flowSteps(flow).findIndex((entry) => entry.id === 'processing');

const onTierStep = (state: SetupState): SetupState => {
  const tierStep = flowSteps(state.flow).findIndex((entry) => entry.id === 'processing');
  return tierStep === -1 ? state : { ...state, step: Math.min(state.step, tierStep), completed: false };
};

/**
 * The tier once the server data has loaded: the default for a setup that has not taken the decision,
 * and a "keep" checked against the library's model only when that model is known (a failed config read
 * keeps the saved choice). An unchosen default that becomes "keep" changes nothing in the library, so
 * it needs no confirmation; one that becomes a tier after the administrator moved past the tier step
 * sends setup back there.
 */
export const settleLoadedTier = (
  state: SetupState,
  context: { hardware?: TierHardware | null; currentModel?: string | null },
): SetupState => {
  const defaulted = withDefaultTier(state, context);
  const next = context.currentModel ? reconcileKeptModel(defaulted, context) : defaulted;
  return next.choices.model !== state.choices.model && next.choices.model !== KEEP_MODEL ? onTierStep(next) : next;
};

/**
 * Checked at finish against the model the server has now. Finishing changes the library's model (and
 * re-indexes) only for a tier the administrator chose; "keep" changes nothing. Answers the setup to show
 * on the tier step when the choice must be confirmed again: an unchosen tier that is no longer this
 * model's default, or a "keep" of a model other than the one it named (`seenModel`: the model this page
 * loaded, for saves that did not record it). Answers null when setup may finish.
 */
export const settleFinishTier = (
  state: SetupState,
  context: { hardware?: TierHardware | null; currentModel?: string | null },
  seenModel?: string | null,
): SetupState | null => {
  const { model, modelChosen, keptModel } = state.choices;
  if (model === KEEP_MODEL) {
    const named = keptModel || seenModel;
    if (!named || !context.currentModel || named === context.currentModel) {
      return null;
    }
    return onTierStep(reconcileKeptModel({ ...state, choices: { ...state.choices, keptModel: named } }, context));
  }
  if (modelChosen) {
    return null;
  }
  const next = defaultTier(state.flow, context);
  if (next === model) {
    return null;
  }
  const kept = next === KEEP_MODEL ? (context.currentModel ?? '') : '';
  return onTierStep({ ...state, choices: { ...state.choices, model: next, keptModel: kept } });
};

export const KEEP_LAYOUT = 'keep';
/** `short` names the layout in Ready's summary (item 5): "Year / Month", not a sample file path. */
export const layoutPresets: readonly {
  id: string;
  label: Translations;
  short: Translations;
  pattern: string;
  recommended?: boolean;
}[] = [
  {
    id: 'year-month',
    label: 'frameleaf_setup_layout_year_month',
    short: 'frameleaf_setup_layout_year_month_short',
    pattern: '{{y}}/{{MM}}/{{filename}}',
    recommended: true,
  },
  {
    id: 'date',
    label: 'frameleaf_setup_layout_date',
    short: 'frameleaf_setup_layout_date_short',
    pattern: '{{y}}/{{y}}-{{MM}}-{{dd}}/{{filename}}',
  },
  {
    id: 'album',
    label: 'frameleaf_setup_layout_album',
    short: 'frameleaf_setup_layout_album_short',
    pattern: '{{album}}/{{y}}/{{filename}}',
  },
  {
    id: 'camera',
    label: 'frameleaf_setup_layout_camera',
    short: 'frameleaf_setup_layout_camera_short',
    pattern: '{{make}} {{model}}/{{y}}/{{filename}}',
  },
];
export const layoutPattern = (layout: string, current: string) =>
  layout === KEEP_LAYOUT ? current : (layoutPresets.find((entry) => entry.id === layout) ?? layoutPresets[0]).pattern;

export type SetupChoices = {
  language: string;
  /** FL-708: always `local` on a new server; an existing library's choice to link a Frameleaf account. */
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
  model: ModelChoice;
  /** Set once the administrator picks a model on the tier step; a default never sets it. */
  modelChosen: boolean;
  /** The library model "keep current model" named; empty for a tier. */
  keptModel: string;
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

export type SetupContext = {
  secrets?: { password?: string; confirm?: string };
  storageWritable?: boolean | null;
};

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
      // FL-708: every administrator is local first; a Frameleaf account is linked on top, or skipped.
      signIn: 'local',
      linked: false,
      accountCreated: false,
      signedIn: false,
      restore: null,
      adminName: '',
      adminEmail: '',
      layout: existing ? KEEP_LAYOUT : 'year-month',
      model: DEFAULT_TIER,
      modelChosen: false,
      keptModel: '',
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
  const errors: Partial<Record<'name' | 'email' | 'password' | 'confirm' | 'storage', Translations>> = {};
  const { choices } = state;
  const secrets = context.secrets ?? {};
  // FL-708: a new server always gets its local administrator here (name, email and a password of at
  // least 8 characters); nothing else stands in for it.
  if (stepId === 'account' && state.flow === 'new' && !choices.accountCreated) {
    if (!choices.adminName.trim()) {
      errors.name = 'frameleaf_setup_error_name';
    }
    if (!validEmail(choices.adminEmail)) {
      errors.email = 'frameleaf_setup_error_email';
    }
    if (!passwordStrength(secrets.password ?? '').acceptable) {
      errors.password = 'frameleaf_setup_error_password';
    } else if (secrets.password !== secrets.confirm) {
      errors.confirm = 'frameleaf_setup_error_confirm';
    }
  }
  if (stepId === 'library' && context.storageWritable === false) {
    errors.storage = 'frameleaf_setup_error_storage';
  }
  if (stepId === 'admin-sign-in' && !choices.signedIn && !(secrets.password ?? '').trim()) {
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
  if (passed.has('account') && state.flow === 'new') {
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

/**
 * Where processing can run. FL-544: the Cloud option is gone from setup (it was recorded and never
 * applied); cloud processing is turned on from the Get Frameleaf Cloud sheet after setup.
 */
export const processingOptions = (state: SetupState): ProcessingChoice[] => [
  'local',
  ...(state.flow === 'existing' ? (['later'] as const) : []),
];

// ---------------------------------------------------------- saved progress

/** The server's password-free progress payload for this state. */
export const toProgress = (state: SetupState): FrameleafSetupProgressDto => {
  const { restore, model, keptModel, ...choices } = state.choices;
  return {
    version: 1,
    step: flowSteps(state.flow)[state.step].id,
    reached: state.reached,
    // "keep current model" is saved as a choice with no tier
    choices: {
      ...choices,
      ...(model === KEEP_MODEL ? keptModel && { keptModel } : { model }),
      ...(restore && { restore }),
    } as FrameleafSetupProgressDto['choices'],
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
      return found === -1 ? 0 : found;
    }
    return Number.isSafeInteger(value) ? Math.min(last, Math.max(0, value as number)) : 0;
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
      model:
        // "keep" is saved with no tier: chosen, or with the model it named
        choices.model === undefined && (choices.modelChosen === true || !!text(choices.keptModel, 200))
          ? KEEP_MODEL
          : oneOf<ModelChoice>(choices.model, [KEEP_MODEL, ...modelTiers.map((entry) => entry.id)], defaults.model),
      // Saves from before `modelChosen` held the default tier unless the administrator chose another.
      modelChosen:
        choices.modelChosen === undefined
          ? typeof choices.model === 'string' && choices.model !== DEFAULT_TIER && reached >= tierStepOf(flow)
          : bool(choices.modelChosen, false),
      keptModel: text(choices.keptModel, 200),
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
  // A signed-in administrator is past the sign-in gate (existing) or the administrator form (new).
  const past = flowSteps(flow).findIndex((entry) => entry.id === (flow === 'existing' ? 'admin-sign-in' : 'account'));
  const step = Math.max(past + 1, state.step);
  return { ...state, step, reached: Math.max(state.reached, step) };
};

type KeyValueStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
// Absent during server rendering, where a bare `localStorage` would throw.
const browserStorage = (): KeyValueStore | undefined =>
  typeof localStorage === 'undefined' ? undefined : localStorage;

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

// ------------------------------------------------------ Frameleaf account

export type FrameleafAccountMode = 'create' | 'sign-in';
export type FrameleafAccountForm = { mode: FrameleafAccountMode; name: string; email: string; password: string };

/** Where "Create account and link" sends people to read the Terms of Use (owner decision 2026-10-06). */
export const FRAMELEAF_TERMS_URL = 'https://frameleaf.app/legal';

/**
 * FL-708 (item 20): the optional Frameleaf account step, after the local administrator exists.
 * `create` makes a new account (name, email, a password of at least 8 characters, as on Frameleaf Cloud); `sign-in` uses one
 * the administrator already has (email and password). The password never enters saved state.
 */
export const validateFrameleafAccount = ({ mode, name, email, password }: FrameleafAccountForm) => {
  const errors: Partial<Record<'name' | 'email' | 'password', Translations>> = {};
  if (mode === 'create' && !name.trim()) {
    errors.name = 'frameleaf_setup_error_name';
  }
  if (!validEmail(email)) {
    errors.email = 'frameleaf_setup_error_email';
  }
  if (mode === 'create' && !passwordStrength(password).acceptable) {
    errors.password = 'frameleaf_setup_error_password';
  } else if (mode === 'sign-in' && !password) {
    errors.password = 'frameleaf_setup_error_frameleaf_password';
  }
  return { ok: Object.keys(errors).length === 0, errors };
};

/**
 * FL-708 (FC-222): the words for each reason Frameleaf Cloud did not link with the account. Never
 * says whether an email has an account, except `email-taken`, which the cloud only sends after the
 * emailed code proved the address is the person's own.
 */
const ACCOUNT_LINK_REFUSAL_MESSAGES: Record<CloudAccountLinkRefusal, Translations> = {
  [CloudAccountLinkRefusal.InvalidCredentials]: 'frameleaf_setup_frameleaf_error_invalid_credentials',
  [CloudAccountLinkRefusal.EmailTaken]: 'frameleaf_setup_frameleaf_error_email_taken',
  [CloudAccountLinkRefusal.PasswordTooShort]: 'frameleaf_setup_error_password',
  [CloudAccountLinkRefusal.PasswordBreached]: 'frameleaf_setup_frameleaf_error_password_breached',
  [CloudAccountLinkRefusal.ConsentOutdated]: 'frameleaf_setup_frameleaf_error_consent_outdated',
  [CloudAccountLinkRefusal.CodeInvalid]: 'frameleaf_setup_frameleaf_error_code_invalid',
  [CloudAccountLinkRefusal.CodeExpired]: 'frameleaf_setup_frameleaf_error_code_expired',
  [CloudAccountLinkRefusal.AccountRefused]: 'frameleaf_setup_frameleaf_error_account_refused',
  [CloudAccountLinkRefusal.InstanceLimit]: 'frameleaf_setup_frameleaf_error_instance_limit',
  [CloudAccountLinkRefusal.InstanceIdTaken]: 'frameleaf_setup_frameleaf_error_server_registered',
  [CloudAccountLinkRefusal.KeyAlreadyLinked]: 'frameleaf_setup_frameleaf_error_server_registered',
  [CloudAccountLinkRefusal.RegionMismatch]: 'frameleaf_setup_frameleaf_error_region_mismatch',
  [CloudAccountLinkRefusal.RateLimited]: 'frameleaf_setup_frameleaf_error_rate_limited',
  [CloudAccountLinkRefusal.Paused]: 'frameleaf_setup_frameleaf_error_paused',
  [CloudAccountLinkRefusal.Unavailable]: 'frameleaf_setup_cloud_unreachable_body',
};

export const accountLinkRefusalMessage = (
  refusal: CloudAccountLinkRefusal,
  retryAfterSeconds: number | null = null,
  attemptsLeft: number | null = null,
): Translations => {
  if (refusal === CloudAccountLinkRefusal.CodeInvalid && attemptsLeft !== null) {
    return 'frameleaf_setup_frameleaf_error_code_invalid_left';
  }
  if (refusal === CloudAccountLinkRefusal.RateLimited && retryAfterSeconds) {
    return 'frameleaf_setup_frameleaf_error_rate_limited_for';
  }
  return ACCOUNT_LINK_REFUSAL_MESSAGES[refusal];
};

/** The account form starts from the administrator's own name and email. */
export const frameleafAccountForm = (
  state: SetupState,
  mode: FrameleafAccountMode = 'create',
): FrameleafAccountForm => ({
  mode,
  name: state.choices.adminName,
  email: state.choices.adminEmail,
  password: '',
});

// ----------------------------------------------------------- estimates

/** Items an hour this hardware indexes at the recommended tier. */
export const itemsPerHour = (gpu: boolean, embeddingMs?: number | null) =>
  embeddingMs && embeddingMs > 0 ? Math.max(300, Math.round(3_600_000 / (embeddingMs * 4))) : gpu ? 5400 : 1200;

/** Hours to re-index a library locally at the chosen model tier. */
export const reindexHours = (items: number, tierId: ModelChoice, perHour: number) => {
  const tier =
    modelTiers.find((entry) => entry.id === tierId) ?? modelTiers.find((entry) => entry.id === DEFAULT_TIER)!;
  const rate = Math.max(1, perHour * tier.speed);
  return Math.max(1, Math.round(Math.max(0, items || 0) / rate));
};

export const tierForModel = (modelName: string | undefined): ModelTier | null =>
  modelTiers.find((entry) => entry.model === modelName)?.id ?? null;

// ------------------------------------------------------ applying choices

/**
 * The settings the finished setup writes. Nothing changes for a choice the administrator left at
 * "keep" or "decide later": the existing layout and the current models (`KEEP_MODEL`) stay as they are. An existing
 * library keeps its face model unless the administrator moved it from one tier to another
 * (`defaultTier`); a library on a search model outside the tiers keeps it too. Switching the search
 * or face model re-embeds the whole library, so it only ever follows a choice.
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
      const current = tierForModel(config.machineLearning.clip.modelName);
      if (state.flow === 'new' || (current !== null && current !== tier.id)) {
        next.machineLearning.facialRecognition.modelName = tier.face;
      }
    }
  }
  next.backup.database.enabled = choices.nightlyBackup;
  next.newVersionCheck.enabled = choices.updates;
  next.map.enabled = choices.map;
  return next;
};

/** Whether finishing re-indexes the library: a search or face model changes and processing isn't deferred. */
export const needsReindex = (config: AdminConfigDto, state: SetupState) => {
  if (state.flow !== 'existing' || state.choices.processing === 'later') {
    return false;
  }
  const next = applySetupChoices(config, state).machineLearning;
  return (
    next.clip.modelName !== config.machineLearning.clip.modelName ||
    next.facialRecognition?.modelName !== config.machineLearning.facialRecognition?.modelName
  );
};

// -------------------------------------------------------- route guard

/**
 * FL-176: while setup is incomplete an administrator is sent to it from every signed-in page;
 * other accounts keep using the library.
 */
export const setupRedirect = (
  pathname: string | (() => string),
  user: { isAdmin: boolean } | undefined,
  server: { isInitialized: boolean; isOnboarded: boolean },
) => {
  if (!user?.isAdmin || !server.isInitialized || server.isOnboarded) {
    return null;
  }
  // Read only now: a route `load` that reads `url.pathname` runs again on every path change
  const path = typeof pathname === 'function' ? pathname() : pathname;
  if (path.startsWith('/auth/') || path.startsWith('/maintenance') || path.startsWith('/link')) {
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
  const ids = new Set<unknown>(accountToolSections.map((entry) => entry.id));
  const done = Array.isArray(source.done) ? source.done.filter((id): id is AccountSectionId => ids.has(id)) : [];
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
