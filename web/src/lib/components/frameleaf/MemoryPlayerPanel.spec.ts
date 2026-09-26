import { updateMemory, type MemoryResponseDto } from '@immich/sdk';
import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { goto } from '$app/navigation';
import { memoryManager } from '$lib/managers/memory-manager.svelte';
import en from '../../../../../i18n/en.json';
import MemoryPlayerPanel from './MemoryPlayerPanel.svelte';

vi.mock('$app/navigation', () => ({ afterNavigate: vi.fn(), goto: vi.fn().mockResolvedValue(undefined) }));
vi.mock('$app/state', () => ({
  page: {
    params: { id: 'memory-1' },
    url: new URL('http://localhost/memories/memory-1?assetId=asset-2'),
  },
}));
vi.mock('$lib/managers/auth-manager.svelte', () => ({
  authManager: {
    authenticated: false,
    user: { id: 'me' },
    params: {},
    preferences: { memories: { enabled: true, duration: 5 }, download: { archiveSize: 4 } },
  },
}));
vi.mock('@immich/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@immich/sdk')>()),
  searchMemories: vi.fn().mockResolvedValue([]),
  memoriesStatistics: vi.fn().mockResolvedValue({ total: 0 }),
  getMemoryExports: vi.fn().mockResolvedValue([]),
  getAssetInfo: vi.fn().mockResolvedValue({
    id: 'asset-2',
    exifInfo: { city: 'Lisbon' },
    people: [
      { id: 'person-1', name: 'Ana', isHidden: false, updatedAt: '2026-01-01T00:00:00.000Z' },
      { id: 'person-2', name: 'Hidden', isHidden: true, updatedAt: '2026-01-01T00:00:00.000Z' },
      { id: 'person-3', name: '', isHidden: false, updatedAt: '2026-01-01T00:00:00.000Z' },
    ],
  }),
  getVideoMoments: vi.fn().mockResolvedValue({ coverTimestampMs: null, frames: [] }),
  updateMemory: vi.fn(),
}));

const asset = (id: string) => ({
  id,
  type: 'IMAGE',
  visibility: 'timeline',
  originalFileName: `${id}.jpg`,
  localDateTime: '2025-09-25T10:00:00.000Z',
  fileCreatedAt: '2025-09-25T10:00:00.000Z',
  isFavorite: false,
  thumbhash: null,
  ownerId: 'me',
});

const memory = () =>
  ({
    id: 'memory-1',
    type: 'on_this_day',
    data: { year: 2025 },
    title: null,
    isHidden: false,
    isSaved: false,
    memoryAt: '2025-09-25T00:00:00.000Z',
    showAt: '2026-09-25T00:00:00.000Z',
    hideAt: '2026-09-25T23:59:59.999Z',
    createdAt: '2026-09-25T00:00:00.000Z',
    updatedAt: '2026-09-25T00:00:00.000Z',
    ownerId: 'me',
    assets: [asset('asset-1'), asset('asset-2'), asset('asset-3')],
  }) as unknown as MemoryResponseDto;

describe('MemoryPlayerPanel (FL-62)', () => {
  beforeAll(() => {
    addMessages('dev', en);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    memoryManager.memories = [memory()];
  });

  afterEach(() => {
    memoryManager.memories = [];
  });

  it('names the memory, its subtitle and count, and each progress segment (MPY-9)', () => {
    render(MemoryPlayerPanel);

    const header = screen.getByRole('banner');
    expect(within(header).getByText('On this day')).toBeInTheDocument();
    expect(within(header).getByText(/September 25, 2025/)).toBeInTheDocument();
    expect(within(header).getByText(/3 items/)).toBeInTheDocument();
    const progress = screen.getByRole('group', { name: 'Memory progress' });
    expect(within(progress).getByRole('link', { name: 'Go to item 2 of 3' })).toHaveAttribute('aria-current', 'true');
  });

  it('toggles the gallery with G and the soundtrack with M (MPY-5, MPY-6, MPY-7)', async () => {
    render(MemoryPlayerPanel);

    await fireEvent.keyDown(document.body, { key: 'g' });
    const gallery = screen.getByRole('region', { name: 'All items in this memory' });
    expect(within(gallery).getByRole('button', { name: 'Item 2: asset-2.jpg' })).toHaveAttribute(
      'aria-current',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Close gallery' })).toHaveAttribute('aria-pressed', 'true');

    await fireEvent.keyDown(document.body, { key: 'm' });
    expect(screen.getByRole('button', { name: 'Mute soundtrack' })).toHaveAttribute('aria-pressed', 'true');

    await fireEvent.keyDown(document.body, { key: 'g' });
    expect(screen.queryByRole('region', { name: 'All items in this memory' })).not.toBeInTheDocument();
  });

  it('ignores a held key auto-repeating', async () => {
    render(MemoryPlayerPanel);

    await fireEvent.keyDown(document.body, { key: 'g' });
    await fireEvent.keyDown(document.body, { key: 'g', repeat: true });

    expect(screen.getByRole('region', { name: 'All items in this memory' })).toBeInTheDocument();
  });

  it('shows the named, visible people of the current item (MPY-8)', async () => {
    render(MemoryPlayerPanel);

    expect(await screen.findByLabelText('People: Ana')).toBeInTheDocument();
  });

  it('reorders items from the gallery and saves the order on the memory', async () => {
    vi.mocked(updateMemory).mockResolvedValue(memory());
    render(MemoryPlayerPanel);

    await fireEvent.click(screen.getByRole('button', { name: 'Show all items' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Reorder' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Move asset-3.jpg earlier' }));

    expect(updateMemory).toHaveBeenCalledWith({
      id: 'memory-1',
      memoryUpdateDto: { assetOrder: ['asset-1', 'asset-3', 'asset-2'] },
    });
  });

  it('opens Studio with the memory items (MPY-10)', async () => {
    render(MemoryPlayerPanel);

    await fireEvent.click(screen.getByRole('button', { name: 'Make a movie in Studio' }));

    expect(goto).toHaveBeenCalledWith(expect.stringMatching(/^\/studio\?.*asset-1.*asset-2.*asset-3/));
  });
});
