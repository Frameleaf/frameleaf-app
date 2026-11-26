import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import en from '../../../../../../../i18n/en.json';
import KeepRules from './KeepRules.svelte';

const auth = vi.hoisted(() => ({
  authenticated: true,
  preferences: { duplicates: { keepRules: [] as string[] } },
  setPreferences: vi.fn(),
}));
vi.mock('$lib/managers/auth-manager.svelte', () => ({ authManager: auth }));

const rules = () =>
  within(screen.getByRole('list', { name: en.frameleaf_keep_title }))
    .getAllByRole('listitem')
    .map((item) => item.querySelector('b')?.textContent);

describe('KeepRules (FL-832)', () => {
  beforeAll(() => addMessages('dev', en));
  beforeEach(() => {
    vi.resetAllMocks();
    auth.preferences = { duplicates: { keepRules: [] } };
    auth.setPreferences.mockImplementation((preferences) => (auth.preferences = preferences));
  });

  it('shows the default order, with RAW deciding the example', () => {
    render(KeepRules);

    expect(rules().slice(0, 4)).toEqual(['RAW', 'HEIC', 'Largest file', 'Most details']);
    expect(rules()).toHaveLength(10);
    expect(screen.getByText('Kept: IMG_2048.CR3, because of “RAW”, rule 1.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reset to default order' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move RAW up' })).toBeDisabled();
  });

  it('saves a moved rule straight away and the example follows', async () => {
    sdkMock.updateMyPreferences.mockImplementation(({ userPreferencesUpdateDto }) =>
      Promise.resolve({ duplicates: userPreferencesUpdateDto.duplicates } as never),
    );
    render(KeepRules);

    for (let step = 0; step < 9; step++) {
      await fireEvent.click(screen.getByRole('button', { name: 'Move Favorite up' }));
    }

    expect(rules()[0]).toBe('Favorite');
    expect(screen.getByText('Kept: IMG_2048.JPG, because of “Favorite”, rule 1.')).toBeInTheDocument();
    await waitFor(() =>
      expect(
        sdkMock.updateMyPreferences.mock.calls.at(-1)?.[0].userPreferencesUpdateDto.duplicates?.keepRules?.[0],
      ).toBe('favorite'),
    );
    const last = sdkMock.updateMyPreferences.mock.calls.at(-1)?.[0].userPreferencesUpdateDto.duplicates?.keepRules;
    expect(last?.slice(0, 2)).toEqual(['favorite', 'raw']);
    expect(last).toHaveLength(10);
  });

  it('shows a saved order and resets it by saving an empty list', async () => {
    auth.preferences = { duplicates: { keepRules: ['newest', 'favorite'] } };
    sdkMock.updateMyPreferences.mockResolvedValue({ duplicates: { keepRules: [] } } as never);
    render(KeepRules);
    expect(rules().slice(0, 3)).toEqual(['Newest', 'Favorite', 'RAW']);

    await fireEvent.click(screen.getByRole('button', { name: 'Reset to default order' }));

    expect(rules()[0]).toBe('RAW');
    expect(sdkMock.updateMyPreferences).toHaveBeenCalledWith({
      userPreferencesUpdateDto: { duplicates: { keepRules: [] } },
    });
  });

  it('puts the saved order back when saving fails', async () => {
    sdkMock.updateMyPreferences.mockRejectedValue(new Error('offline'));
    render(KeepRules);

    await fireEvent.click(screen.getByRole('button', { name: 'Move HEIC up' }));

    await waitFor(() => expect(rules()[0]).toBe('RAW'));
  });

  it('says the default order uses four rules, until a rule is moved', async () => {
    sdkMock.updateMyPreferences.mockResolvedValue({ duplicates: { keepRules: [] } } as never);
    render(KeepRules);
    expect(screen.getByText(en.frameleaf_keep_default_note)).toBeInTheDocument();

    await fireEvent.click(screen.getByRole('button', { name: 'Move HEIC up' }));

    expect(screen.queryByText(en.frameleaf_keep_default_note)).toBeNull();
  });

  it('sends saves one at a time and goes back to the last saved order when a later one fails', async () => {
    let finishFirst: (value: unknown) => void = () => {};
    sdkMock.updateMyPreferences
      .mockImplementationOnce(() => new Promise((resolve) => (finishFirst = resolve)) as never)
      .mockRejectedValueOnce(new Error('offline'));
    render(KeepRules);

    await fireEvent.click(screen.getByRole('button', { name: 'Move HEIC up' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Move Largest file up' }));
    expect(sdkMock.updateMyPreferences).toHaveBeenCalledTimes(1);

    finishFirst({ duplicates: { keepRules: ['heic', 'raw'] } });

    await waitFor(() => expect(sdkMock.updateMyPreferences).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(rules().slice(0, 3)).toEqual(['HEIC', 'RAW', 'Largest file']));
  });
});
