import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import { addMessages } from 'svelte-i18n';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { goto } from '$app/navigation';
import en from '$i18n/en.json';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import FirstRunSetup from '$lib/components/frameleaf/setup/FirstRunSetup.svelte';
import { createSetup } from '$lib/frameleaf/first-run-setup';

vi.mock('$app/navigation', () => ({ goto: vi.fn(), invalidateAll: vi.fn() }));

describe('first-run progress save ownership', () => {
  beforeAll(() => addMessages('dev', en));

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    localStorage.clear();
    sdkMock.updateFrameleafSetup.mockResolvedValue({} as never);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('saves locally immediately and sends the current progress after the debounce', async () => {
    render(FirstRunSetup, { initial: createSetup('existing'), authenticated: true });
    await tick();
    expect(JSON.parse(localStorage.getItem('frameleaf:setup:v1')!)).toMatchObject({
      flow: 'existing',
      step: 'admin-sign-in',
      completed: false,
    });
    await vi.advanceTimersByTimeAsync(299);
    expect(sdkMock.updateFrameleafSetup).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(sdkMock.updateFrameleafSetup).toHaveBeenCalledExactlyOnceWith({
      frameleafSetupUpdateDto: {
        flow: 'existing',
        progress: {
          version: 1,
          step: 'admin-sign-in',
          reached: 0,
          choices: {
            language: 'en',
            signIn: 'local',
            linked: false,
            accountCreated: false,
            signedIn: false,
            adminName: '',
            adminEmail: '',
            layout: 'keep',
            model: 'balanced',
            modelChosen: false,
            processing: 'local',
            nightlyBackup: true,
            updates: true,
            map: true,
            theme: 'dark',
          },
        },
      },
    });
  });

  it('cancels a pending server save when setup leaves the page, retaining its local copy', async () => {
    const view = render(FirstRunSetup, { initial: createSetup('existing'), authenticated: true });
    await tick();
    await vi.advanceTimersByTimeAsync(200);
    view.unmount();
    await vi.advanceTimersByTimeAsync(1000);
    expect(sdkMock.updateFrameleafSetup).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem('frameleaf:setup:v1')!)).toMatchObject({
      flow: 'existing',
      completed: false,
    });
  });

  it('does not let an old setup overwrite progress from a new mounted setup', async () => {
    const first = render(FirstRunSetup, { initial: createSetup('existing'), authenticated: true });
    await tick();
    await vi.advanceTimersByTimeAsync(200);
    first.unmount();
    render(FirstRunSetup, { initial: createSetup('new'), authenticated: true });
    await tick();
    await vi.advanceTimersByTimeAsync(300);
    expect(sdkMock.updateFrameleafSetup).toHaveBeenCalledTimes(1);
    expect(sdkMock.updateFrameleafSetup).toHaveBeenLastCalledWith({
      frameleafSetupUpdateDto: {
        flow: 'new',
        progress: expect.objectContaining({ version: 1, step: 'welcome', reached: 0 }),
      },
    });
  });

  it('restarts the debounce for an edited choice and sends only the latest snapshot', async () => {
    const initial = { ...createSetup('existing'), step: 6, reached: 6 };
    render(FirstRunSetup, { initial, authenticated: true });
    await tick();
    await vi.advanceTimersByTimeAsync(200);
    await fireEvent.click(screen.getByRole('switch', { name: en.frameleaf_setup_privacy_map }));
    await vi.advanceTimersByTimeAsync(100);
    expect(sdkMock.updateFrameleafSetup).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(sdkMock.updateFrameleafSetup).toHaveBeenCalledExactlyOnceWith({
      frameleafSetupUpdateDto: {
        flow: 'existing',
        progress: {
          version: 1,
          step: 'privacy',
          reached: 6,
          choices: expect.objectContaining({ map: false, updates: true }),
        },
      },
    });
    expect(JSON.parse(localStorage.getItem('frameleaf:setup:v1')!).choices.map).toBe(false);
  });

  it('keeps failed saves resumable and tries again after another choice changes', async () => {
    sdkMock.updateFrameleafSetup.mockRejectedValueOnce(new Error('offline'));
    render(FirstRunSetup, { initial: { ...createSetup('existing'), step: 6, reached: 6 }, authenticated: true });
    await tick();
    await vi.advanceTimersByTimeAsync(300);
    await fireEvent.click(screen.getByRole('switch', { name: en.frameleaf_setup_privacy_map }));
    await vi.advanceTimersByTimeAsync(300);
    expect(sdkMock.updateFrameleafSetup).toHaveBeenCalledTimes(2);
    expect(JSON.parse(localStorage.getItem('frameleaf:setup:v1')!).choices.map).toBe(false);
  });

  it('cancels pending progress when setup completes while its page is still mounted', async () => {
    sdkMock.getConfig.mockResolvedValue({
      storageTemplate: { enabled: false, template: '{{y}}/{{MM}}/{{filename}}' },
      machineLearning: { clip: { enabled: true, modelName: 'ViT-B-16-SigLIP2__webli' } },
      backup: { database: { enabled: true, cronExpression: '0 02 * * *', keepLastAmount: 14 } },
      newVersionCheck: { enabled: true },
      map: { enabled: true },
    } as never);
    sdkMock.finishFrameleafSetup.mockResolvedValue({ completed: true, completedAt: null, flow: 'existing' } as never);
    sdkMock.setUserOnboarding.mockResolvedValue({ isOnboarded: true });
    const initial = createSetup('existing');
    render(FirstRunSetup, {
      initial: { ...initial, step: 9, reached: 9, choices: { ...initial.choices, signedIn: true } },
      authenticated: true,
    });
    await tick();
    await vi.advanceTimersByTimeAsync(200);
    await fireEvent.click(screen.getByRole('button', { name: 'Open Frameleaf' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(goto).toHaveBeenCalledWith('/photos', { invalidateAll: true });
    await vi.advanceTimersByTimeAsync(1000);
    expect(sdkMock.updateFrameleafSetup).not.toHaveBeenCalled();
  });

  it.each([
    { authenticated: false, completed: false },
    { authenticated: true, completed: true },
  ])('does not send progress for $authenticated authentication and $completed completion', async (state) => {
    render(FirstRunSetup, {
      initial: { ...createSetup('existing'), completed: state.completed },
      authenticated: state.authenticated,
    });
    await tick();
    await vi.advanceTimersByTimeAsync(1000);
    expect(sdkMock.updateFrameleafSetup).not.toHaveBeenCalled();
  });
});
