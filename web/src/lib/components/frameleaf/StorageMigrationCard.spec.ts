import { act, render, screen } from '@testing-library/svelte';
import { addMessages, init as initI18n } from 'svelte-i18n';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { StorageMigrationStatus } from '$lib/frameleaf/storage-migration';
import en from '../../../../../i18n/en.json';
import StorageMigrationCard from './StorageMigrationCard.svelte';

const status = (overrides: Partial<StorageMigrationStatus> = {}): StorageMigrationStatus => ({
  stage: 'linking',
  required: true,
  background: true,
  showInGettingReady: false,
  stages: {
    checking: { done: 10, total: 10 },
    relinking: { done: 3, total: 3 },
    linking: { done: 40, total: 100 },
    trashing: { done: 0, total: 0 },
  },
  relinked: 2,
  toReview: 1,
  skipped: 0,
  bytesFreed: 0,
  estimatedSecondsLeft: null,
  startedAt: null,
  finishedAt: null,
  ...overrides,
});

describe('StorageMigrationCard (FL-326)', () => {
  let fetchMock: Mock<typeof fetch>;

  beforeAll(async () => {
    addMessages('en', en);
    await initI18n({ fallbackLocale: 'en', initialLocale: 'en' });
  });

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const mount = async (value: StorageMigrationStatus | 404) => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(value === 404 ? new Response(null, { status: 404 }) : Response.json(value)),
    );
    render(StorageMigrationCard);
    await act(() => vi.advanceTimersByTimeAsync(0));
  };

  it('shows the stages while it runs in the background', async () => {
    await mount(status());
    expect(screen.getByText('Combining duplicate files')).toBeInTheDocument();
    expect(screen.getByText('40 of 100')).toBeInTheDocument();
    expect(screen.getByText(/2 relinked, 1 to review/)).toBeInTheDocument();
    expect(screen.getByText(/Extra copies are not freed until it finishes/)).toBeInTheDocument();
  });

  it('names the missing originals left for review once done', async () => {
    await mount(status({ stage: 'done', toReview: 2 }));
    expect(screen.getByText('Finished with 2 files to review in Library Care')).toBeInTheDocument();
    expect(screen.getByText('2 missing originals to review below')).toBeInTheDocument();
  });

  it.each([
    ['done with nothing to review', status({ stage: 'done', toReview: 0 })],
    ['a library that had nothing to combine', status({ stage: 'done', required: false, toReview: 0 })],
  ])('stays hidden when %s', async (_name, value) => {
    await mount(value);
    expect(screen.queryByText(/Combining duplicate files|to review/)).not.toBeInTheDocument();
  });

  it('stays hidden on a server without the migration', async () => {
    await mount(404);
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });
});
