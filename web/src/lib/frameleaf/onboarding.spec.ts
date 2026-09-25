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
      'frameleaf_account',
      'license',
      'backup',
      'mobile_app',
      'done',
    ]);
    expect(onboardingStepsFor(OnboardingRole.SERVER)).toHaveLength(11);
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

  it('renders the live storage template example, and only notes tokens it cannot preview', () => {
    expect(renderStorageTemplate('{{y}}/{{y}}-{{MM}}-{{dd}}/{{filename}}', 'taylor')).toEqual({
      path: 'library/taylor/2026/2026-09-14/IMG_4021.jpg',
      unknown: [],
      previewable: true,
    });
    // Valid server tokens the sample does not know are not errors; the server validates on save.
    const block = renderStorageTemplate('{{#if album}}{{album}}{{else}}Other{{/if}}/{{filename}}', 'taylor');
    expect(block.previewable).toBe(false);
    expect(block.unknown).toEqual(['#if album', 'else', '/if']);
    expect(renderStorageTemplate('{{album-startDate-y}}/{{filename}}', 'taylor').unknown).toEqual([
      'album-startDate-y',
    ]);
    expect(renderStorageTemplate('', 'taylor')).toMatchObject({ previewable: true, path: 'library/taylor/….jpg' });
  });

  it('inserts a variable at the cursor', () => {
    expect(insertStorageToken('{{y}}/{{filename}}', '{{MM}}/', 6, 6)).toEqual({
      pattern: '{{y}}/{{MM}}/{{filename}}',
      caret: 13,
    });
    expect(insertStorageToken('abc', '{{y}}')).toEqual({ pattern: 'abc{{y}}', caret: 8 });
  });
});
