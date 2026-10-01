import { act, render, screen } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import en from '../../../../i18n/en.json';
import Page from './+page.svelte';

const state = vi.hoisted(() => ({
  page: { url: new URL('/getting-ready?continue=%2Fauth%2Flogin', location.origin), params: {} },
}));
vi.mock('$app/state', () => state);

/** The real address, before a test replaces `location`. */
const origin = location.origin;

const json = (status: number, body: unknown) => Promise.resolve(Response.json(body, { status }));

describe('Getting Ready… (FL-295)', () => {
  let fetchMock: Mock<typeof fetch>;
  let assign: Mock<(url: string) => void>;

  beforeEach(() => {
    vi.useFakeTimers();
    addMessages('dev', en);
    fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    assign = vi.fn<(url: string) => void>();
    vi.stubGlobal('location', { ...location, origin, assign });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const nextPoll = () => act(() => vi.advanceTimersByTimeAsync(1000));

  it('explains the safety copy while it is made, then moves on to the page asked for once the server is ready', async () => {
    fetchMock
      .mockImplementationOnce(() => json(200, { state: 'checking' }))
      .mockImplementationOnce(() => json(200, { state: 'backing-up' }))
      .mockImplementationOnce(() =>
        json(200, {
          state: 'done',
          copy: 'taken',
          backup: { filename: 'immich-db-backup-20261001T101500-pre-upgrade-v3.2.0-pg14.19.sql.gz', takenAt: 'x' },
        }),
      )
      .mockImplementationOnce(() => Promise.reject(new TypeError('Failed to fetch')))
      .mockImplementationOnce(() => json(404, { message: 'Not Found' }));

    render(Page);
    await act(() => vi.advanceTimersByTimeAsync(0));

    expect(screen.getByRole('heading', { name: 'Getting Ready…' })).toBeInTheDocument();
    expect(screen.getByText(/making a safety copy of your library before upgrading it/)).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Getting ready' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Checking your library…');

    await nextPoll();
    expect(screen.getByRole('status')).toHaveTextContent('Making the safety copy…');

    await nextPoll();
    expect(screen.getByRole('heading', { name: 'Safety copy saved' })).toBeInTheDocument();
    expect(
      screen.getByText('Saved as immich-db-backup-20261001T101500-pre-upgrade-v3.2.0-pg14.19.sql.gz'),
    ).toBeInTheDocument();

    // the server hands over and is briefly not answering while it upgrades
    await nextPoll();
    expect(screen.getByRole('heading', { name: 'Almost ready…' })).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();

    await nextPoll();
    expect(assign).toHaveBeenCalledWith(new URL('/auth/login', origin).href);
  });

  it('names the recent backup that made the copy unnecessary', async () => {
    fetchMock.mockImplementation(() =>
      json(200, {
        state: 'skipped',
        copy: 'skipped',
        backup: { filename: 'immich-db-backup-20261001T020000-v3.1.0-pg14.19.sql.gz', takenAt: '2026-10-01T02:00:00' },
      }),
    );

    render(Page);
    await act(() => vi.advanceTimersByTimeAsync(0));

    expect(screen.getByRole('heading', { name: 'Your library was backed up recently' })).toBeInTheDocument();
    expect(
      screen.getByText('Backup found: immich-db-backup-20261001T020000-v3.1.0-pg14.19.sql.gz'),
    ).toBeInTheDocument();
    expect(screen.getByText('Not needed')).toBeInTheDocument();
  });

  it('says plainly what to do when there is not enough space, and stays there', async () => {
    fetchMock.mockImplementation(() =>
      json(200, {
        state: 'failed',
        error: { reason: 'disk-space', requiredBytes: 8 * 1024 ** 3, availableBytes: 2 * 1024 ** 3 },
      }),
    );

    render(Page);
    await act(() => vi.advanceTimersByTimeAsync(0));
    await nextPoll();

    expect(screen.getByRole('heading', { name: "Frameleaf couldn't make the safety copy" })).toBeInTheDocument();
    expect(screen.getByText(/It needs about 8 GiB, and 2 GiB is free. Nothing was changed./)).toBeInTheDocument();
    expect(
      screen.getByText(/Free up some space where your library is stored, then restart Frameleaf/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
  });

  it('explains any other failure without technical details', async () => {
    fetchMock.mockImplementation(() => json(200, { state: 'failed', error: { reason: 'backup-failed' } }));

    render(Page);
    await act(() => vi.advanceTimersByTimeAsync(0));

    expect(
      screen.getByText(/Nothing was changed, so your library still works with the server you used before/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Check the server logs for details, then restart Frameleaf/)).toBeInTheDocument();
  });

  it('never sends the visitor back to this page', async () => {
    state.page.url = new URL('/getting-ready?continue=%2Fgetting-ready', origin);
    fetchMock.mockImplementation(() => json(404, {}));

    render(Page);
    await act(() => vi.advanceTimersByTimeAsync(0));

    expect(assign).toHaveBeenCalledWith('/');
  });
});
