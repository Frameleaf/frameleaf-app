import { act, fireEvent, render, screen } from '@testing-library/svelte';
import { addMessages, init as initI18n } from 'svelte-i18n';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { StorageMigrationStatus } from '$lib/frameleaf/storage-migration';
import en from '../../../../../i18n/en.json';
import GettingReadyCombine from './GettingReadyCombine.svelte';

const status = (overrides: Partial<StorageMigrationStatus> = {}): StorageMigrationStatus => ({
  stage: 'relinking',
  required: true,
  background: false,
  showInGettingReady: true,
  stages: {
    checking: { done: 48_210, total: 48_210 },
    relinking: { done: 5, total: 11 },
    linking: { done: 0, total: 3120 },
    trashing: { done: 0, total: 0 },
  },
  relinked: 4,
  toReview: 1,
  skipped: 0,
  bytesFreed: 0,
  estimatedSecondsLeft: 250,
  startedAt: '2026-10-03T12:00:00.000Z',
  finishedAt: null,
  ...overrides,
});

const json = (code: number, body: unknown) => Promise.resolve(Response.json(body, { status: code }));

describe('GettingReadyCombine (FL-326)', () => {
  let fetchMock: Mock<typeof fetch>;
  const handlers = () => ({ onContinue: vi.fn(), onOpenLibraryCare: vi.fn(), onSignIn: vi.fn() });

  beforeAll(async () => {
    addMessages('en', en);
    await initI18n({ fallbackLocale: 'en', initialLocale: 'en' });
  });

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.open = true;
    };
    HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
      this.open = false;
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('shows each stage as X of Y, the relink line and the time left, with no Continue', () => {
    render(GettingReadyCombine, { initial: status(), ...handlers() });

    expect(screen.getByRole('heading', { name: 'Combining duplicate files' })).toBeInTheDocument();
    expect(screen.getByText('5 of 11')).toBeInTheDocument();
    expect(screen.getByText('4 relinked, 1 to review')).toBeInTheDocument();
    expect(screen.getByText('About 5 minutes left')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Combining duplicate files' })).toHaveAttribute(
      'aria-valuenow',
      '36',
    );
    expect(screen.queryByRole('button', { name: 'Continue' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run in background instead' })).toBeInTheDocument();
  });

  it('follows the server until it is done, then offers Continue', async () => {
    const props = handlers();
    fetchMock.mockImplementation(() => json(200, status({ stage: 'done', toReview: 0, bytesFreed: 2048 })));
    render(GettingReadyCombine, { initial: status(), ...props });

    await act(() => vi.advanceTimersByTimeAsync(2000));

    expect(screen.getByRole('heading', { name: 'Done' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('of extra copies moved to the file trash');
    await fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(props.onContinue).toHaveBeenCalled();
  });

  it('ends with the files to review in Library Care', async () => {
    const props = handlers();
    render(GettingReadyCombine, { initial: status({ stage: 'done', toReview: 3 }), ...props });

    expect(
      screen.getByRole('heading', { name: 'Finished with 3 files to review in Library Care' }),
    ).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Open Library Care' }));
    expect(props.onOpenLibraryCare).toHaveBeenCalled();
  });

  it('asks before running in the background, then continues', async () => {
    const props = handlers();
    fetchMock.mockImplementation(() => json(200, status({ background: true, showInGettingReady: false })));
    render(GettingReadyCombine, { initial: status(), ...props });

    await fireEvent.click(screen.getByRole('button', { name: 'Run in background instead' }));
    expect(screen.getByText(/The extra copies are not freed until it finishes/)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();

    await fireEvent.click(screen.getByRole('button', { name: 'Run in background' }));
    await act(() => vi.advanceTimersByTimeAsync(0));

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/server/storage-migration/background',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(props.onContinue).toHaveBeenCalled();
  });

  it('asks a visitor who is not an administrator to sign in first', async () => {
    const props = handlers();
    fetchMock.mockImplementation(() => Promise.resolve(new Response(null, { status: 401 })));
    render(GettingReadyCombine, { initial: status(), ...props });

    await fireEvent.click(screen.getByRole('button', { name: 'Run in background instead' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Run in background' }));
    await act(() => vi.advanceTimersByTimeAsync(0));

    expect(props.onContinue).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Sign in as an administrator');
    await fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(props.onSignIn).toHaveBeenCalled();
  });
});
