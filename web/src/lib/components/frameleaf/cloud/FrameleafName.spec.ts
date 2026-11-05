import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { nameRule, tidyName } from '$lib/frameleaf/frameleaf-name';
import FrameleafName from './FrameleafName.svelte';

const state = (name: string) => ({
  name,
  address: `${name}.frameleaf.net`,
  relayAddress: 'r.u225vlzhsdlhwh4l.frameleaf.net',
  routed: true,
  previous: [],
});

describe('FrameleafName (FL-1197)', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });

  beforeEach(() => {
    vi.clearAllMocks();
    sdkMock.checkRemoteName.mockImplementation(
      ({ remoteNameUpdateDto: { name } }) =>
        Promise.resolve(
          name === 'photos'
            ? { name, address: null, verdict: 'taken', reason: 'taken', message: null }
            : { name, address: `${name}.frameleaf.net`, verdict: 'available', reason: null, message: null },
        ) as never,
    );
    sdkMock.setRemoteName.mockImplementation(({ remoteNameUpdateDto: { name } }) => Promise.resolve(state(name)));
  });

  it('follows the rules Frameleaf Cloud checks, and tidies what is typed', () => {
    expect(tidyName(' Taylor Home! ')).toBe('taylor-home');
    expect(['ab', 'a'.repeat(41), 'a_b', '-ab', 'taylor-home'].map((name) => nameRule(name))).toEqual([
      'too_short',
      'too_long',
      'characters',
      'hyphen_at_edge',
      null,
    ]);
  });

  it('checks a new name as it is typed and claims it, saying the old one keeps working', async () => {
    const onSaved = vi.fn();
    render(FrameleafName, { name: 'taylor-home', onSaved });
    expect(screen.getByText('taylor-home')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Change name…' }));
    const input = screen.getByRole('textbox', { name: 'Name for this server on frameleaf.net' });

    await fireEvent.input(input, { target: { value: 'Photos' } });
    expect(await screen.findByText('Someone already has this name.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Use this name' })).toBeDisabled();

    await fireEvent.input(input, { target: { value: 'cedar-home' } });
    await fireEvent.click(await screen.findByRole('button', { name: 'Use cedar-home.frameleaf.net' }));
    await waitFor(() =>
      expect(onSaved).toHaveBeenCalledWith(
        state('cedar-home'),
        'Changed to cedar-home.frameleaf.net. Links with taylor-home.frameleaf.net keep working for 30 days.',
      ),
    );
    expect(sdkMock.setRemoteName).toHaveBeenCalledWith({ remoteNameUpdateDto: { name: 'cedar-home' } });
  });

  it('asks for a name when the server has none, and never asks Cloud about one that breaks the rules', async () => {
    render(FrameleafName, { name: null, onSaved: vi.fn() });
    await fireEvent.input(screen.getByRole('textbox'), { target: { value: 'ab' } });
    expect(screen.getByText('Use at least 3 characters.')).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(sdkMock.checkRemoteName).not.toHaveBeenCalled();
  });

  it('says the check failed instead of checking forever', async () => {
    sdkMock.checkRemoteName.mockRejectedValue(new Error('offline'));
    render(FrameleafName, { name: null, onSaved: vi.fn() });
    await fireEvent.input(screen.getByRole('textbox'), { target: { value: 'cedar-home' } });
    expect(await screen.findByText('That did not work. Try again.')).toBeInTheDocument();
  });

  it('clears a failed check once the name checks out', async () => {
    sdkMock.checkRemoteName.mockRejectedValueOnce(new Error('offline'));
    render(FrameleafName, { name: null, onSaved: vi.fn() });
    const input = screen.getByRole('textbox');
    await fireEvent.input(input, { target: { value: 'cedar-home' } });
    expect(await screen.findByText('That did not work. Try again.')).toBeInTheDocument();
    await fireEvent.input(input, { target: { value: 'cedar-hom' } });
    await fireEvent.input(input, { target: { value: 'cedar-home' } });
    expect(await screen.findByRole('button', { name: 'Use cedar-home.frameleaf.net' })).toBeEnabled();
    expect(screen.queryByText('That did not work. Try again.')).not.toBeInTheDocument();
  });
});
