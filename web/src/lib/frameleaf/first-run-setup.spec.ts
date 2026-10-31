import { CloudAccountLinkRefusal, type AdminConfigDto } from '@frameleaf/sdk';
import { describe, expect, it } from 'vitest';
import en from '$i18n/en.json';
import {
  accountLinkRefusalMessage,
  accountToolProgress,
  applySetupChoices,
  chapterCount,
  createSetup,
  defaultTier,
  firstInvalidStep,
  flowSteps,
  frameleafAccountForm,
  FRAMELEAF_TERMS_URL,
  goToStep,
  KEEP_LAYOUT,
  KEEP_MODEL,
  keepsUnlistedModel,
  loadAccountTool,
  loadLocalSetup,
  markSection,
  needsReindex,
  parseSetup,
  processingOptions,
  recommendedTier,
  reconcileKeptModel,
  resumeSetup,
  saveAccountTool,
  saveLocalSetup,
  setLinked,
  setupRedirect,
  setupStageTheme,
  showsRequired,
  themeAfterSetup,
  toProgress,
  validateFrameleafAccount,
  validateStep,
  withDefaultTier,
  type TierHardware,
} from '$lib/frameleaf/first-run-setup';

const memory = () => {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
    data,
  };
};

const strong = { password: 'correct horse battery', confirm: 'correct horse battery' };
const indexOf = (flow: 'new' | 'existing', id: string) => flowSteps(flow).findIndex((entry) => entry.id === id);

describe('first-run setup state (FL-176)', () => {
  it('has the prototype step order for both flows', () => {
    expect(flowSteps('new').map((entry) => entry.id)).toEqual([
      'welcome',
      'account',
      'frameleaf-account',
      'library',
      'processing',
      'protection',
      'privacy',
      'imports',
      'ready',
    ]);
    expect(flowSteps('existing').map((entry) => entry.id)).toEqual([
      'admin-sign-in',
      'welcome',
      'account',
      'library-check',
      'processing',
      'protection',
      'privacy',
      'people',
      'imports',
      'ready',
    ]);
  });

  it('makes every administrator local first and keeps the layout on an existing library (FL-708)', () => {
    expect(createSetup('new').choices).toMatchObject({ signIn: 'local', linked: false, layout: 'year-month' });
    expect(createSetup('existing').choices).toMatchObject({ signIn: 'local', layout: KEEP_LAYOUT });
  });

  it('counts the chapters the rail shows, not the inner steps (item 2)', () => {
    expect(chapterCount('account')).toEqual({ chapter: 'frameleaf_setup_chapter_account', position: 2, count: 5 });
    expect(chapterCount('ready')).toMatchObject({ position: 5, count: 5 });
  });

  it('shows "Required" only on the administrator form (item 4)', () => {
    const state = createSetup('new');
    expect(showsRequired(state, 'account')).toBe(true);
    expect(showsRequired(state, 'library')).toBe(false);
    expect(showsRequired(state, 'frameleaf-account')).toBe(false);
    expect(showsRequired({ ...state, choices: { ...state.choices, accountCreated: true } }, 'account')).toBe(false);
    expect(showsRequired(createSetup('existing'), 'account')).toBe(false);
  });

  describe('required steps', () => {
    it('requires a complete local admin before leaving the account step', () => {
      let state = createSetup('new');
      expect(validateStep(state, 'account').errors).toMatchObject({
        name: 'frameleaf_setup_error_name',
        email: 'frameleaf_setup_error_email',
        password: 'frameleaf_setup_error_password',
      });
      state = { ...state, choices: { ...state.choices, adminName: 'Ada', adminEmail: 'ada@example.com' } };
      expect(validateStep(state, 'account', { secrets: { password: 'weak', confirm: 'weak' } }).ok).toBe(false);
      // FL-708 item 19: eight characters is the only rule; no character classes
      const seven = { password: 'sevench', confirm: 'sevench' };
      expect(validateStep(state, 'account', { secrets: seven }).errors).toEqual({
        password: 'frameleaf_setup_error_password',
      });
      const plain = { password: 'aaaaaaaa', confirm: 'aaaaaaaa' };
      expect(validateStep(state, 'account', { secrets: plain }).ok).toBe(true);
      expect(validateStep(state, 'account', { secrets: { ...strong, confirm: 'other' } }).errors).toEqual({
        confirm: 'frameleaf_setup_error_confirm',
      });
      expect(validateStep(state, 'account', { secrets: strong }).ok).toBe(true);
    });

    it('never lets a Frameleaf link stand in for the local administrator (FL-708 item 20)', () => {
      // linked (say, by a headless link token) but no administrator yet: the form is still required
      const state = setLinked(createSetup('new'), true);
      expect(validateStep(state, 'account').errors).toMatchObject({ name: 'frameleaf_setup_error_name' });
      // the administrator exists: the account step is done whether or not the server is linked
      const created = { ...createSetup('new'), choices: { ...createSetup('new').choices, accountCreated: true } };
      expect(validateStep(created, 'account').ok).toBe(true);
      // and the Frameleaf account step never blocks: it can be skipped
      expect(validateStep(created, 'frameleaf-account').ok).toBe(true);
    });

    it('requires a writable library location', () => {
      const state = createSetup('new');
      expect(validateStep(state, 'library', { storageWritable: false }).ok).toBe(false);
      expect(validateStep(state, 'library', { storageWritable: true }).ok).toBe(true);
    });

    it('requires the admin password at the existing-library gate', () => {
      const state = createSetup('existing');
      expect(validateStep(state, 'admin-sign-in').ok).toBe(false);
      expect(validateStep(state, 'admin-sign-in', { secrets: { password: 'x' } }).ok).toBe(true);
    });

    it('does not move forward past an invalid step, and marks the account created once passed', () => {
      let state = { ...createSetup('new'), step: indexOf('new', 'account') };
      expect(goToStep(state, state.step + 1)).toBe(state);
      state = { ...state, choices: { ...state.choices, adminName: 'Ada', adminEmail: 'ada@example.com' } };
      const next = goToStep(state, state.step + 1, { secrets: strong });
      expect(next.step).toBe(indexOf('new', 'frameleaf-account'));
      expect(next.choices.accountCreated).toBe(true);
      expect(next.reached).toBe(next.step);
      // back is always allowed
      expect(goToStep(next, 0).step).toBe(0);
    });
  });

  it('drops the choices that need Frameleaf when unlinking', () => {
    let state = setLinked(createSetup('existing'), true);
    expect(processingOptions(state)).toEqual(['local', 'later']);
    state = { ...state, choices: { ...state.choices, processing: 'cloud', restore: 'restore' } };
    const unlinked = setLinked(state, false);
    expect(unlinked.choices).toMatchObject({ processing: 'local', restore: null });
    expect(processingOptions(unlinked)).toEqual(['local', 'later']);
    expect(processingOptions(createSetup('new'))).toEqual(['local']);
  });

  describe('resume', () => {
    it('saves a password-free payload and resumes from it', () => {
      const store = memory();
      let state = { ...createSetup('new'), step: 5, reached: 6 };
      state = { ...state, choices: { ...state.choices, signIn: 'local', accountCreated: true, adminName: 'Ada' } };
      saveLocalSetup(state, store);
      expect(store.data.get('frameleaf:setup:v1')).not.toMatch(/password/i);
      const resumed = loadLocalSetup('new', store);
      expect(resumed).toMatchObject({ step: 5, reached: 6, choices: { adminName: 'Ada', accountCreated: true } });
      expect(loadLocalSetup('existing', store)).toBeNull();
    });

    it('never resumes past a required step that no longer checks out', () => {
      const progress = toProgress({ ...createSetup('new'), step: 6, reached: 6 });
      const resumed = parseSetup({ ...progress, flow: 'new' }, 'new');
      expect(resumed?.step).toBe(indexOf('new', 'account'));
    });

    it('rejects foreign or broken payloads', () => {
      expect(parseSetup('{', 'new')).toBeNull();
      expect(parseSetup({ version: 2 }, 'new')).toBeNull();
      expect(parseSetup({ version: 1, flow: 'existing' }, 'new')).toBeNull();
    });

    it('prefers the server copy and skips the gate for a signed-in admin', () => {
      const server = toProgress({ ...createSetup('existing'), step: 3, reached: 3 });
      expect(resumeSetup('existing', { server }, true)).toMatchObject({ step: 3, choices: { signedIn: true } });
      expect(resumeSetup('existing', {}, true).step).toBe(1);
      expect(resumeSetup('existing', {}, false).step).toBe(0);
      // FL-708: a signed-in administrator on a new server resumes at the optional Frameleaf account
      const created = resumeSetup('new', {}, true);
      expect(created.choices).toMatchObject({ accountCreated: true, signIn: 'local', linked: false });
      expect(created.step).toBe(indexOf('new', 'frameleaf-account'));
      expect(firstInvalidStep(created)).toBe(-1);
      // progress saved by an older build on the removed "How you'll sign in" step starts again
      const old = parseSetup({ version: 1, flow: 'new', step: 'sign-in-choice', reached: 1, choices: {} }, 'new');
      expect(old?.step).toBe(0);
    });
  });

  describe('applying choices', () => {
    const config = {
      storageTemplate: { enabled: false, template: '{{y}}/{{filename}}', hashVerificationEnabled: true },
      machineLearning: {
        clip: { enabled: true, modelName: 'ViT-B-32__openai' },
        facialRecognition: { enabled: true, modelName: 'antelopev2' },
      },
      backup: { database: { enabled: false, cronExpression: '0 02 * * *', keepLastAmount: 14 } },
      newVersionCheck: { enabled: false },
      map: { enabled: true, lightStyle: '', darkStyle: '' },
    } as unknown as AdminConfigDto;

    it('writes the layout, models, nightly backups and privacy choices', () => {
      const state = createSetup('new');
      const next = applySetupChoices(config, { ...state, choices: { ...state.choices, map: false } });
      expect(next.storageTemplate).toMatchObject({ enabled: true, template: '{{y}}/{{MM}}/{{filename}}' });
      expect(next.machineLearning.clip.modelName).toBe('ViT-B-16-SigLIP-384__webli');
      expect(next.machineLearning.facialRecognition.modelName).toBe('buffalo_l');
      expect(next.backup.database.enabled).toBe(true);
      expect(next.newVersionCheck.enabled).toBe(true);
      expect(next.map.enabled).toBe(false);
      expect(config.map.enabled).toBe(true);
    });

    it('keeps the current layout and models when asked, and re-indexes only for a model change', () => {
      const state = createSetup('existing');
      expect(applySetupChoices(config, state).storageTemplate).toEqual(config.storageTemplate);
      expect(needsReindex(config, state)).toBe(true);
      const later = { ...state, choices: { ...state.choices, processing: 'later' as const } };
      expect(applySetupChoices(config, later).machineLearning.clip.modelName).toBe('ViT-B-32__openai');
      expect(needsReindex(config, later)).toBe(false);
      expect(needsReindex(config, createSetup('new'))).toBe(false);
    });

    it("moves an existing library's face model only with its tier, never on its own (A2)", () => {
      // the library's tier (light) chosen again: both models stay, nothing re-embeds
      const light = {
        ...createSetup('existing'),
        choices: { ...createSetup('existing').choices, model: 'light' as const },
      };
      expect(applySetupChoices(config, light).machineLearning).toMatchObject({
        clip: { modelName: 'ViT-B-32__openai' },
        facialRecognition: { modelName: 'antelopev2' },
      });
      expect(needsReindex(config, light)).toBe(false);
      // another tier chosen: search and faces move together, and the library re-indexes
      const best = { ...light, choices: { ...light.choices, model: 'best' as const } };
      expect(applySetupChoices(config, best).machineLearning).toMatchObject({
        clip: { modelName: 'ViT-SO400M-16-SigLIP2-384__webli' },
        facialRecognition: { modelName: 'antelopev2' },
      });
      expect(needsReindex(config, best)).toBe(true);
      const balanced = { ...light, choices: { ...light.choices, model: 'balanced' as const } };
      expect(applySetupChoices(config, balanced).machineLearning.facialRecognition.modelName).toBe('buffalo_l');
      // a face-only change counts as a re-index too
      const sameSearch = {
        ...config,
        machineLearning: {
          ...config.machineLearning,
          clip: { ...config.machineLearning.clip, modelName: 'ViT-SO400M-16-SigLIP2-384__webli' },
        },
      };
      expect(needsReindex(sameSearch, balanced)).toBe(true);
      // a library on a search model outside the tiers keeps its face model whatever tier is chosen
      const custom = {
        ...config,
        machineLearning: {
          ...config.machineLearning,
          clip: { ...config.machineLearning.clip, modelName: 'custom-model' },
        },
      };
      expect(applySetupChoices(custom, best).machineLearning).toMatchObject({
        clip: { modelName: 'ViT-SO400M-16-SigLIP2-384__webli' },
        facialRecognition: { modelName: 'antelopev2' },
      });
      expect(applySetupChoices(custom, balanced).machineLearning.facialRecognition.modelName).toBe('antelopev2');
    });
  });

  describe('the hardware-driven tier (A2)', () => {
    const ml = (patch: Partial<TierHardware['ml']>): TierHardware => ({
      ml: { reachable: true, backend: 'CUDA', vramGb: 24, integrated: false, ...patch },
    });

    it('recommends light on a processor or an integrated GPU, balanced from 6 GB and best from 12 GB', () => {
      expect(recommendedTier(ml({ backend: 'CPU', vramGb: null }))).toBe('light');
      expect(recommendedTier(ml({ backend: 'OpenVINO', vramGb: null, integrated: true }))).toBe('light');
      expect(recommendedTier(ml({ backend: 'ROCm', vramGb: 16, integrated: true }))).toBe('light');
      expect(recommendedTier(ml({ vramGb: 4 }))).toBe('light');
      expect(recommendedTier(ml({ vramGb: 6 }))).toBe('balanced');
      expect(recommendedTier(ml({ vramGb: 11.5 }))).toBe('balanced');
      expect(recommendedTier(ml({ vramGb: 12 }))).toBe('best');
      expect(recommendedTier(ml({ backend: 'ROCm', vramGb: 24 }))).toBe('best');
      // unknown hardware or memory keeps the server's own default
      expect(recommendedTier(null)).toBe('balanced');
      expect(recommendedTier(ml({ reachable: false, backend: 'CPU', vramGb: null }))).toBe('balanced');
      expect(recommendedTier(ml({ vramGb: null, integrated: null }))).toBe('balanced');
    });

    it('starts a new server at the recommended tier and an existing library at its own', () => {
      const gpu = ml({ vramGb: 24 });
      expect(defaultTier('new', { hardware: gpu })).toBe('best');
      expect(defaultTier('new', { hardware: null })).toBe('balanced');
      expect(defaultTier('existing', { hardware: gpu, currentModel: 'ViT-B-32__openai' })).toBe('light');
      expect(defaultTier('existing', { hardware: gpu, currentModel: 'ViT-SO400M-16-SigLIP2-384__webli' })).toBe('best');
      expect(defaultTier('existing', { hardware: gpu, currentModel: 'custom-model' })).toBe(KEEP_MODEL);
      expect(defaultTier('existing', { hardware: gpu })).toBe('balanced');

      const fresh = withDefaultTier(createSetup('new'), { hardware: gpu });
      expect(fresh.choices.model).toBe('best');
      expect(
        withDefaultTier(createSetup('new'), { hardware: ml({ backend: 'CPU', vramGb: null }) }).choices.model,
      ).toBe('light');
      const existing = withDefaultTier(createSetup('existing'), { hardware: gpu, currentModel: 'ViT-B-32__openai' });
      expect(existing.choices.model).toBe('light');
      // no change, no new state
      const same = createSetup('new');
      expect(withDefaultTier(same, { hardware: ml({ vramGb: 8 }) })).toBe(same);
    });

    it('pre-selects keeping an unlisted search model and leaves it unchanged unless a tier is chosen', () => {
      const config = {
        storageTemplate: { enabled: false, template: '{{y}}/{{filename}}', hashVerificationEnabled: true },
        machineLearning: {
          clip: { enabled: true, modelName: 'custom-model' },
          facialRecognition: { enabled: true, modelName: 'antelopev2' },
        },
        backup: { database: { enabled: false, cronExpression: '0 02 * * *', keepLastAmount: 14 } },
        newVersionCheck: { enabled: false },
        map: { enabled: true, lightStyle: '', darkStyle: '' },
      } as unknown as AdminConfigDto;
      expect(keepsUnlistedModel('existing', 'custom-model')).toBe(true);
      expect(keepsUnlistedModel('existing', 'ViT-B-32__openai')).toBe(false);
      expect(keepsUnlistedModel('existing', undefined)).toBe(false);
      expect(keepsUnlistedModel('new', 'custom-model')).toBe(false);
      // a new server still starts at the hardware's tier
      expect(defaultTier('new', { hardware: ml({ vramGb: 24 }), currentModel: 'custom-model' })).toBe('best');

      const kept = withDefaultTier(createSetup('existing'), {
        hardware: ml({ vramGb: 24 }),
        currentModel: 'custom-model',
      });
      expect(kept.choices.model).toBe(KEEP_MODEL);
      expect(applySetupChoices(config, kept).machineLearning).toEqual(config.machineLearning);
      expect(needsReindex(config, kept)).toBe(false);
      // the choice survives a resume
      expect(parseSetup(JSON.stringify(kept), 'existing')?.choices.model).toBe(KEEP_MODEL);

      // choosing a tier still switches the search model and re-indexes, as before
      const best = { ...kept, choices: { ...kept.choices, model: 'best' as const } };
      expect(applySetupChoices(config, best).machineLearning.clip.modelName).toBe('ViT-SO400M-16-SigLIP2-384__webli');
      expect(needsReindex(config, best)).toBe(true);
    });

    describe('saved progress past the tier step, on a library with an unlisted search model', () => {
      const tierStep = flowSteps('existing').findIndex((entry) => entry.id === 'processing');
      const context = { hardware: ml({ vramGb: 24 }), currentModel: 'custom-model' };
      const saved = (choices: Record<string, unknown>) => ({
        version: 1,
        step: flowSteps('existing')[tierStep + 1].id,
        reached: tierStep + 1,
        choices: { signedIn: true, ...choices },
      });
      const resume = (progress: ReturnType<typeof saved>) =>
        withDefaultTier(resumeSetup('existing', { server: progress as never }, true), context);

      it('offers keeping the current model when an older save holds only the default tier', () => {
        expect(resume(saved({ model: 'balanced' })).choices.model).toBe(KEEP_MODEL);
        expect(resume(saved({})).choices.model).toBe(KEEP_MODEL);
      });

      it('honours a tier the administrator chose', () => {
        const state = resume(saved({ model: 'balanced', modelChosen: true }));
        expect(state.choices.model).toBe('balanced');
        expect(withDefaultTier(state, context)).toBe(state);
      });

      it('saves and resumes an explicit keep without sending an unknown tier', () => {
        const kept = {
          ...createSetup('existing'),
          step: tierStep + 1,
          reached: tierStep + 1,
          choices: { ...createSetup('existing').choices, model: KEEP_MODEL, modelChosen: true },
        };
        const progress = toProgress(kept);
        expect(progress.choices).not.toHaveProperty('model');
        expect(progress.choices.modelChosen).toBe(true);
        expect(resume(progress as ReturnType<typeof saved>).choices.model).toBe(KEEP_MODEL);
        // a default keep is not saved as a choice and is offered again
        const pending = toProgress({ ...kept, choices: { ...kept.choices, modelChosen: false } });
        expect(resume(pending as ReturnType<typeof saved>).choices.model).toBe(KEEP_MODEL);
      });

      it('keeps an older save past the tier step that holds a tier other than the default', () => {
        expect(resume(saved({ model: 'best' })).choices.model).toBe('best');
      });

      it('saves the kept model with the choice and asks again when it changed while setup was closed', () => {
        const kept = withDefaultTier(createSetup('existing'), context);
        expect(kept.choices.keptModel).toBe('custom-model');
        const chosen = {
          ...kept,
          step: tierStep + 1,
          reached: tierStep + 1,
          choices: { ...kept.choices, modelChosen: true },
        };
        const progress = toProgress(chosen);
        expect(progress.choices).toMatchObject({ keptModel: 'custom-model', modelChosen: true });
        const resumed = resumeSetup('existing', { server: progress }, true);
        expect(reconcileKeptModel(resumed, context)).toBe(resumed);

        // another unlisted model now: "keep" is offered for it, and setup returns to the tier step
        const other = reconcileKeptModel(resumed, { ...context, currentModel: 'other-model' });
        expect(other.choices).toMatchObject({ model: KEEP_MODEL, modelChosen: false, keptModel: 'other-model' });
        expect(other.step).toBe(tierStep);
        // a listed model now: its tier, back on the tier step
        const listed = reconcileKeptModel(resumed, { ...context, currentModel: 'ViT-B-32__openai' });
        expect(listed.choices).toMatchObject({ model: 'light', modelChosen: false, keptModel: '' });
        expect(listed.step).toBe(tierStep);
      });
    });

    it("keeps the administrator's tier once the tier step was reached", () => {
      const steps = flowSteps('new');
      const tierStep = steps.findIndex((entry) => entry.id === 'processing');
      const chosen = {
        ...createSetup('new'),
        step: tierStep,
        reached: tierStep,
        choices: { ...createSetup('new').choices, model: 'light' as const },
      };
      expect(withDefaultTier(chosen, { hardware: ml({ vramGb: 24 }) })).toBe(chosen);
      const passed = { ...createSetup('new'), step: tierStep + 1, reached: tierStep + 1 };
      expect(withDefaultTier(passed, { hardware: ml({ vramGb: 24 }) }).choices.model).toBe('balanced');
      // before it, the recommendation still lands
      const before = { ...createSetup('new'), step: tierStep - 1, reached: tierStep - 1 };
      expect(withDefaultTier(before, { hardware: ml({ vramGb: 24 }) }).choices.model).toBe('best');
    });
  });

  describe('admin redirect', () => {
    const open = { isInitialized: true, isOnboarded: false };

    it('sends an administrator to setup from signed-in pages until it is complete', () => {
      expect(setupRedirect('/photos', { isAdmin: true }, open)).toBe('/auth/onboarding');
      expect(setupRedirect('/admin/system-settings', { isAdmin: true }, open)).toBe('/auth/onboarding');
      expect(setupRedirect('/photos', { isAdmin: true }, { ...open, isOnboarded: true })).toBeNull();
    });

    it('never blocks other accounts, and leaves setup, sign-in and maintenance pages alone', () => {
      expect(setupRedirect('/photos', { isAdmin: false }, open)).toBeNull();
      expect(setupRedirect('/auth/onboarding', { isAdmin: true }, open)).toBeNull();
      expect(setupRedirect('/auth/login', { isAdmin: true }, open)).toBeNull();
      expect(setupRedirect('/maintenance', { isAdmin: true }, open)).toBeNull();
      expect(setupRedirect('/link', { isAdmin: true }, open)).toBeNull();
      // the path is only read when the redirect depends on it
      const pathname = vi.fn(() => '/photos');
      expect(setupRedirect(pathname, { isAdmin: true }, { ...open, isOnboarded: true })).toBeNull();
      expect(pathname).not.toHaveBeenCalled();
      expect(setupRedirect(pathname, { isAdmin: true }, open)).toBe('/auth/onboarding');
    });
  });

  it('always runs dark and applies the theme choice afterwards', () => {
    expect(setupStageTheme()).toBe('dark');
    expect(themeAfterSetup('light')).toBe('light');
    expect(themeAfterSetup('dark')).toBe('dark');
    expect(themeAfterSetup(undefined)).toBe('dark');
  });

  it('keeps the account tool progress per account', () => {
    const store = memory();
    const state = markSection(markSection(loadAccountTool('u1', store), 'profile'), 'profile');
    expect(accountToolProgress(state)).toEqual({ done: 1, total: 5 });
    saveAccountTool('u1', state, store);
    expect(loadAccountTool('u1', store).done).toEqual(['profile']);
    expect(loadAccountTool('u2', store).done).toEqual([]);
  });
});

describe('Frameleaf account step (FL-708 item 20)', () => {
  const admin = (() => {
    const state = createSetup('new');
    return { ...state, choices: { ...state.choices, adminName: 'Ada', adminEmail: 'ada@example.com' } };
  })();

  it("starts from the administrator's name and email, never a password", () => {
    expect(frameleafAccountForm(admin)).toEqual({
      mode: 'create',
      name: 'Ada',
      email: 'ada@example.com',
      password: '',
    });
    expect(frameleafAccountForm(admin, 'sign-in').mode).toBe('sign-in');
  });

  it('creates an account with a name, an email and a password of at least 8 characters', () => {
    const form = frameleafAccountForm(admin);
    expect(validateFrameleafAccount(form).errors).toEqual({ password: 'frameleaf_setup_error_password' });
    expect(validateFrameleafAccount({ ...form, password: 'sevench' }).ok).toBe(false);
    expect(validateFrameleafAccount({ ...form, password: 'aaaaaaaaaaaa' }).ok).toBe(true);
    expect(validateFrameleafAccount({ ...form, name: ' ', email: 'nope', password: 'aaaaaaaaaaaa' }).errors).toEqual({
      name: 'frameleaf_setup_error_name',
      email: 'frameleaf_setup_error_email',
    });
  });

  it('has words for every reason Frameleaf Cloud does not link (FC-222)', () => {
    for (const refusal of Object.values(CloudAccountLinkRefusal)) {
      expect(en, refusal).toHaveProperty(accountLinkRefusalMessage(refusal));
    }
    expect(accountLinkRefusalMessage(CloudAccountLinkRefusal.CodeInvalid, null, 2)).toBe(
      'frameleaf_setup_frameleaf_error_code_invalid_left',
    );
    expect(accountLinkRefusalMessage(CloudAccountLinkRefusal.RateLimited, 90)).toBe(
      'frameleaf_setup_frameleaf_error_rate_limited_for',
    );
  });

  it('signs in to an existing account with an email and any password', () => {
    const form = { ...frameleafAccountForm(admin, 'sign-in'), name: '' };
    expect(validateFrameleafAccount(form).errors).toEqual({ password: 'frameleaf_setup_error_frameleaf_password' });
    expect(validateFrameleafAccount({ ...form, password: 'short' }).ok).toBe(true);
  });

  it('links to the Terms of Use on frameleaf.app', () => {
    expect(FRAMELEAF_TERMS_URL).toBe('https://frameleaf.app/legal');
  });
});
