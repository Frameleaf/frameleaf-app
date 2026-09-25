import { searchMemories, updateMemory, type MemoryResponseDto } from '@immich/sdk';
import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { memoryManager } from '$lib/managers/memory-manager.svelte';
import en from '../../../../../i18n/en.json';
import MemoriesPanel from './MemoriesPanel.svelte';

vi.mock('$app/navigation', () => ({ goto: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@immich/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@immich/sdk')>()),
  searchMemories: vi.fn().mockResolvedValue([]),
  memoriesStatistics: vi.fn().mockResolvedValue({ total: 0 }),
  getMemoryShowLess: vi.fn().mockResolvedValue([]),
  updateMemory: vi.fn(),
}));

const memory = (id: string, assets: unknown[]) =>
  ({
    id,
    type: 'on_this_day',
    data: { year: 2020 },
    memoryAt: '2026-09-24T00:00:00.000Z',
    createdAt: '2026-09-24T00:00:00.000Z',
    updatedAt: '2026-09-24T00:00:00.000Z',
    isSaved: false,
    ownerId: 'me',
    assets,
  }) as unknown as MemoryResponseDto;

describe('MemoriesPanel', () => {
  beforeAll(() => {
    addMessages('dev', en);
  });

  afterEach(() => {
    memoryManager.memories = [];
    memoryManager.hidden = [];
    vi.useRealTimers();
  });

  // FL-83: an emptied memory is deleted when its Undo closes, but one the server still returns (a
  // reload inside the window) must not break the index.
  it('renders the index without throwing when a memory has no items', () => {
    memoryManager.memories = [memory('memory-empty', [])];

    expect(() => render(MemoriesPanel)).not.toThrow();
  });

  // FL-62: the card's overline and its hover preview come from the shared Memories engine.
  it('labels a card by kind and gives its cover the engine preview motion', () => {
    memoryManager.memories = [
      memory('memory-1', [
        { id: 'asset-1', type: 'IMAGE', visibility: 'timeline', localDateTime: '2020-09-24T10:00:00.000Z' },
      ]),
    ];

    const { container } = render(MemoriesPanel);

    expect(screen.getByText('Memory')).toBeInTheDocument();
    const cover = container.querySelector(':scope .fm-card-main img');
    expect(cover?.getAttribute('style')).toContain('--kb-from');
    expect(cover?.getAttribute('style')).toContain('--kb-duration: 9s');
  });

  it('never uses a Locked item as the cover', () => {
    memoryManager.memories = [
      memory('memory-2', [
        { id: 'locked-1', type: 'IMAGE', visibility: 'locked', localDateTime: '2020-09-24T10:00:00.000Z' },
        { id: 'asset-2', type: 'IMAGE', visibility: 'timeline', localDateTime: '2020-09-24T10:00:00.000Z' },
      ]),
    ];

    const { container } = render(MemoriesPanel);

    const cover = container.querySelector(':scope .fm-card-main img');
    expect(cover?.getAttribute('src')).toContain('asset-2');
    expect(container.getHTML()).not.toContain('locked-1/thumbnail');
  });

  const asset = (id: string) => ({
    id,
    type: 'IMAGE',
    visibility: 'timeline',
    localDateTime: '2020-09-24T10:00:00.000Z',
  });
  // an "on this day" memory shown for one calendar day (the server's window, UTC here)
  const onDay = (id: string, day: string, year: number) =>
    ({
      ...memory(id, [asset(`${id}-asset`)]),
      data: { year },
      showAt: `${day}T00:00:00.000Z`,
      hideAt: `${day}T23:59:59.999Z`,
    }) as unknown as MemoryResponseDto;

  // FL-62 (MI-2..MI-7): the template's sections, badges and quiet card, from the viewer's local date.
  it('shows Today, Upcoming and Earlier with the template badges', () => {
    vi.useFakeTimers({ now: new Date(2026, 8, 25, 12), toFake: ['Date'] });
    memoryManager.memories = [
      onDay('today', '2026-09-25', 2025),
      onDay('soon', '2026-09-28', 2024),
      onDay('yesterday', '2026-09-24', 2023),
    ];

    render(MemoriesPanel);

    const today = screen.getByRole('region', { name: 'Today' });
    expect(within(today).getByText('On this day')).toBeInTheDocument();
    expect(within(today).getByText('One year ago · September 25, 2025')).toBeInTheDocument();
    const upcoming = screen.getByRole('region', { name: 'Upcoming' });
    expect(within(upcoming).getByText('Next 14 days')).toBeInTheDocument();
    expect(within(upcoming).getByText('In 3 days')).toBeInTheDocument();
    const earlier = screen.getByRole('region', { name: 'Earlier' });
    expect(within(earlier).getByText('Yesterday')).toBeInTheDocument();
    expect(screen.getByText('September 25, 2026 · days worth revisiting from your library')).toBeInTheDocument();
  });

  it('shows the quiet card with the next memory when nothing is for today', () => {
    vi.useFakeTimers({ now: new Date(2026, 8, 25, 12), toFake: ['Date'] });
    memoryManager.memories = [onDay('soon', '2026-09-26', 2024)];

    render(MemoriesPanel);

    expect(screen.getByText('Nothing from this day yet')).toBeInTheDocument();
    expect(
      screen.getByText('Your next memory arrives tomorrow: 2 years ago · September 26, 2024.'),
    ).toBeInTheDocument();
  });

  // MI-1: Hide memory replaces deletion, and Restore brings it back from Hidden memories.
  it('hides a memory into Hidden memories and restores it', async () => {
    const target = onDay('old', '2026-08-01', 2020);
    memoryManager.memories = [target];
    vi.mocked(updateMemory).mockResolvedValueOnce({ ...target, isHidden: true });
    vi.mocked(updateMemory).mockResolvedValueOnce({ ...target, isHidden: false });

    render(MemoriesPanel);

    await fireEvent.click(screen.getByRole('button', { name: /More actions for On this day/ }));
    await fireEvent.click(screen.getByRole('menuitem', { name: 'Hide memory' }));
    await vi.waitFor(() => expect(memoryManager.hidden).toHaveLength(1));
    expect(updateMemory).toHaveBeenCalledWith({ id: 'old', memoryUpdateDto: { isHidden: true } });
    expect(memoryManager.memories).toHaveLength(0);

    await fireEvent.click(await screen.findByRole('button', { name: /Show 1/ }));
    await fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    await vi.waitFor(() => expect(memoryManager.memories).toHaveLength(1));
    expect(updateMemory).toHaveBeenLastCalledWith({ id: 'old', memoryUpdateDto: { isHidden: false } });
    expect(memoryManager.hidden).toHaveLength(0);
  });

  it('loads hidden memories from the server', () => {
    render(MemoriesPanel);
    expect(searchMemories).toHaveBeenCalledWith(expect.objectContaining({ isHidden: true }));
  });

  it('opens Memory settings with the template labels', async () => {
    render(MemoriesPanel);

    await fireEvent.click(screen.getByRole('button', { name: 'Memory settings' }));

    const settings = screen.getByRole('dialog', { name: 'Memory settings' });
    expect(within(settings).getByRole('switch', { name: /Show upcoming/ })).toBeInTheDocument();
    expect(within(settings).getByText('Preview memories for the next two weeks')).toBeInTheDocument();
    expect(within(settings).getByText('Show memories you have marked with a heart')).toBeInTheDocument();
  });
});
