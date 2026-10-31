import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import FrameleafAccountSection from './FrameleafAccountSection.svelte';

const confirm = vi.hoisted(() => ({ answer: true }));
vi.mock('$lib/frameleaf/confirm', () => ({ confirmFrameleaf: vi.fn(() => Promise.resolve(confirm.answer)) }));

describe('FrameleafAccountSection (FL-158)', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });

  beforeEach(() => {
    vi.clearAllMocks();
    confirm.answer = true;
    localStorage.clear();
  });

  it('says the server is not linked yet and offers nothing to link', async () => {
    sdkMock.getFrameleafAccountLink.mockResolvedValue({
      available: false,
      linked: false,
      email: null,
      linkedAt: null,
      lastSignInAt: null,
    });
    render(FrameleafAccountSection);
    expect(await screen.findByText(/has not linked this server to Frameleaf yet/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Link Frameleaf account' })).toBeDisabled();
  });

  it('leaves for Frameleaf to link, returning to /link', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...location, assign, origin: 'https://photos.example.test' });
    sdkMock.getFrameleafAccountLink.mockResolvedValue({
      available: true,
      linked: false,
      email: null,
      linkedAt: null,
      lastSignInAt: null,
    });
    sdkMock.startFrameleafSignIn.mockResolvedValue({ url: 'https://id.frameleaf.cloud.test/auth?state=s1' });
    render(FrameleafAccountSection);

    await fireEvent.click(await screen.findByRole('button', { name: 'Link Frameleaf account' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://id.frameleaf.cloud.test/auth?state=s1'));
    expect(sdkMock.startFrameleafSignIn).toHaveBeenCalledWith({
      oAuthConfigDto: { redirectUri: 'https://photos.example.test/link' },
    });
    vi.unstubAllGlobals();
  });

  it('shows the linked account and unlinks after confirmation', async () => {
    sdkMock.getFrameleafAccountLink.mockResolvedValueOnce({
      available: true,
      linked: true,
      email: 'me@example.test',
      linkedAt: '2026-09-20T10:00:00.000Z',
      lastSignInAt: null,
    });
    sdkMock.getFrameleafAccountLink.mockResolvedValue({
      available: true,
      linked: false,
      email: null,
      linkedAt: null,
      lastSignInAt: null,
    });
    sdkMock.unlinkFrameleafAccount.mockResolvedValue(undefined as never);
    render(FrameleafAccountSection);

    expect(await screen.findByText(/Linked to me@example.test since/)).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Unlink' }));
    await waitFor(() => expect(sdkMock.unlinkFrameleafAccount).toHaveBeenCalled());
    expect(await screen.findByText(/Link your Frameleaf account to sign in/)).toBeInTheDocument();
  });

  it('keeps the link when the confirmation is cancelled', async () => {
    confirm.answer = false;
    sdkMock.getFrameleafAccountLink.mockResolvedValue({
      available: true,
      linked: true,
      email: 'me@example.test',
      linkedAt: '2026-09-20T10:00:00.000Z',
      lastSignInAt: null,
    });
    render(FrameleafAccountSection);
    await fireEvent.click(await screen.findByRole('button', { name: 'Unlink' }));
    expect(sdkMock.unlinkFrameleafAccount).not.toHaveBeenCalled();
  });

  it('leaves loading when the check fails and offers to try again', async () => {
    sdkMock.getFrameleafAccountLink.mockRejectedValueOnce(new Error('down'));
    sdkMock.getFrameleafAccountLink.mockResolvedValue({
      available: false,
      linked: false,
      email: null,
      linkedAt: null,
      lastSignInAt: null,
    });
    render(FrameleafAccountSection);
    expect(await screen.findByText('Your Frameleaf account could not be checked right now.')).toBeInTheDocument();
    expect(screen.queryByText(/Checking your Frameleaf account/)).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(/has not linked this server to Frameleaf yet/)).toBeInTheDocument();
  });
});
