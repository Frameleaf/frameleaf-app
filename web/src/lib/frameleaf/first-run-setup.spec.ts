import type { AdminConfigDto } from '@immich/sdk';
import { describe, expect, it } from 'vitest';
import {
  accountToolProgress,
  applySetupChoices,
  createSetup,
  firstInvalidStep,
  flowSteps,
  goToStep,
  KEEP_LAYOUT,
  loadAccountTool,
  loadLocalSetup,
  markSection,
  needsReindex,
  parseSetup,
  processingOptions,
  resumeSetup,
  saveAccountTool,
  saveLocalSetup,
  setLinked,
  setupRedirect,
  setupStageTheme,
  themeAfterSetup,
  toProgress,
  validateStep,
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

const strong = { password: 'Correct-Horse-9', confirm: 'Correct-Horse-9' };
const indexOf = (flow: 'new' | 'existing', id: string) => flowSteps(flow).findIndex((entry) => entry.id === id);

describe('first-run setup state (FL-176)', () => {
  it('has the prototype step order for both flows', () => {
    expect(flowSteps('new').map((entry) => entry.id)).toEqual([
      'welcome',
      'sign-in-choice',
      'account',
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

  it('recommends a Frameleaf account on a new server and keeps the layout on an existing library', () => {
    expect(createSetup('new').choices).toMatchObject({ signIn: 'frameleaf', layout: 'year-month' });
    expect(createSetup('existing').choices).toMatchObject({ signIn: 'local', layout: KEEP_LAYOUT });
  });

  describe('required steps', () => {
    it('requires a complete local admin before leaving the account step', () => {
      let state = createSetup('new');
      state = { ...state, choices: { ...state.choices, signIn: 'local' } };
      expect(validateStep(state, 'account').errors).toMatchObject({
        name: 'frameleaf_setup_error_name',
        email: 'frameleaf_setup_error_email',
        password: 'frameleaf_setup_error_password',
      });
      state = { ...state, choices: { ...state.choices, adminName: 'Ada', adminEmail: 'ada@example.com' } };
      expect(validateStep(state, 'account', { secrets: { password: 'weak', confirm: 'weak' } }).ok).toBe(false);
      expect(
        validateStep(state, 'account', { secrets: { password: strong.password, confirm: 'other' } }).errors,
      ).toEqual({ confirm: 'frameleaf_setup_error_confirm' });
      expect(validateStep(state, 'account', { secrets: strong }).ok).toBe(true);
    });

    it('requires the Frameleaf link when the admin chose Frameleaf', () => {
      const state = createSetup('new');
      expect(validateStep(state, 'account').errors).toEqual({ link: 'frameleaf_setup_error_link' });
      expect(validateStep(setLinked(state, true), 'account').ok).toBe(true);
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
      state = { ...state, choices: { ...state.choices, signIn: 'local' } };
      expect(goToStep(state, state.step + 1)).toBe(state);
      state = { ...state, choices: { ...state.choices, adminName: 'Ada', adminEmail: 'ada@example.com' } };
      const next = goToStep(state, state.step + 1, { secrets: strong });
      expect(next.step).toBe(indexOf('new', 'library'));
      expect(next.choices.accountCreated).toBe(true);
      expect(next.reached).toBe(next.step);
      // back is always allowed
      expect(goToStep(next, 0).step).toBe(0);
    });
  });

  it('drops the choices that need Frameleaf when unlinking', () => {
    let state = setLinked(createSetup('existing'), true);
    expect(processingOptions(state)).toEqual(['local', 'cloud', 'later']);
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
      const created = resumeSetup('new', {}, true);
      expect(created.choices).toMatchObject({ accountCreated: true, signIn: 'local' });
      expect(firstInvalidStep(created)).toBe(-1);
    });
  });

  describe('applying choices', () => {
    const config = {
      storageTemplate: { enabled: false, template: '{{y}}/{{filename}}', hashVerificationEnabled: true },
      machineLearning: { clip: { enabled: true, modelName: 'ViT-B-32__openai' } },
      backup: { database: { enabled: false, cronExpression: '0 02 * * *', keepLastAmount: 14 } },
      newVersionCheck: { enabled: false },
      map: { enabled: true, lightStyle: '', darkStyle: '' },
    } as unknown as AdminConfigDto;

    it('writes the layout, models, nightly backups and privacy choices', () => {
      const state = createSetup('new');
      const next = applySetupChoices(config, { ...state, choices: { ...state.choices, map: false } });
      expect(next.storageTemplate).toMatchObject({ enabled: true, template: '{{y}}/{{MM}}/{{filename}}' });
      expect(next.machineLearning.clip.modelName).toBe('ViT-B-16-SigLIP2__webli');
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
