import { afterEach, describe, expect, it } from 'vitest';
import { OnboardingRole } from '$lib/types';
import {
  clearOnboardingProgress,
  insertStorageToken,
  loadOnboardingProgress,
  onboardingStepIndex,
  onboardingStepsFor,
  renderStorageTemplate,
  saveOnboardingProgress,
} from './onboarding';

describe('onboarding (FL-80 ON-1)', () => {
  afterEach(() => {
    localStorage.clear();
  });

  it('keeps the prototype step order and hides server steps from other accounts', () => {
    expect(onboardingStepsFor(OnboardingRole.SERVER).map(({ id }) => id)).toEqual([
      'hello',
      'language',
      'theme',
      'server_privacy',
      'user_privacy',
      'storage_template',
      'backup',
      'mobile_app',
      'done',
    ]);
    expect(onboardingStepsFor(OnboardingRole.USER).map(({ id }) => id)).toEqual([
      'hello',
      'language',
      'theme',
      'user_privacy',
      'backup',
      'mobile_app',
      'done',
    ]);
  });

  it('finds a step, falling back to the first', () => {
    const steps = onboardingStepsFor(OnboardingRole.USER);
    expect(onboardingStepIndex(steps, 'backup')).toBe(4);
    expect(onboardingStepIndex(steps, 'storage_template')).toBe(0);
    expect(onboardingStepIndex(steps, null)).toBe(0);
  });

  it('remembers the step reached per account and ignores bad saved data', () => {
    expect(loadOnboardingProgress('a')).toBeNull();
    saveOnboardingProgress('a', { step: 'theme', reached: 3 });
    expect(loadOnboardingProgress('a')).toEqual({ step: 'theme', reached: 3 });
    expect(loadOnboardingProgress('b')).toBeNull();

    localStorage.setItem('frameleaf:onboarding:v1:b', '{"step":"nope","reached":1}');
    expect(loadOnboardingProgress('b')).toBeNull();
    localStorage.setItem('frameleaf:onboarding:v1:b', 'not json');
    expect(loadOnboardingProgress('b')).toBeNull();

    clearOnboardingProgress('a');
    expect(loadOnboardingProgress('a')).toBeNull();
  });

  it('renders the live storage template example and flags unknown variables', () => {
    expect(renderStorageTemplate('{{y}}/{{y}}-{{MM}}-{{dd}}/{{filename}}', 'taylor')).toEqual({
      path: 'library/taylor/2026/2026-09-14/IMG_4021.jpg',
      unknown: [],
      valid: true,
    });
    const bad = renderStorageTemplate('{{nope}}/{{filename}}', 'taylor');
    expect(bad.valid).toBe(false);
    expect(bad.unknown).toEqual(['nope']);
    expect(renderStorageTemplate('../{{filename}}', 'taylor').valid).toBe(false);
    expect(renderStorageTemplate('', 'taylor')).toMatchObject({ valid: false, path: 'library/taylor/….jpg' });
  });

  it('inserts a variable at the cursor', () => {
    expect(insertStorageToken('{{y}}/{{filename}}', '{{MM}}/', 6, 6)).toEqual({
      pattern: '{{y}}/{{MM}}/{{filename}}',
      caret: 13,
    });
    expect(insertStorageToken('abc', '{{y}}')).toEqual({ pattern: 'abc{{y}}', caret: 8 });
  });
});
