import { beforeEach, describe, expect, it, vi } from 'vitest';
import { badgeFor, showBadge } from './badge';
import { listCaptures } from './queue';
import { listMediaReceipts } from './media-queue';
vi.mock('./queue', () => ({ listCaptures: vi.fn() }));
vi.mock('./media-queue', async (original) => ({
  ...(await original<typeof import('./media-queue')>()),
  listMediaReceipts: vi.fn(),
}));
const binding = {
  serverId: 'server-a',
  userId: '11111111-1111-4111-8111-111111111111',
  origin: 'https://photos.example',
  credentialId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
};
let action: Record<string, ReturnType<typeof vi.fn>>;
beforeEach(() => {
  action = {
    setBadgeText: vi.fn().mockResolvedValue(undefined),
    setBadgeBackgroundColor: vi.fn().mockResolvedValue(undefined),
    setTitle: vi.fn().mockResolvedValue(undefined),
  };
  vi.stubGlobal('chrome', { action });
});
describe('toolbar badge', () => {
  it('shows the waiting count in blue, "!" in amber when something needs you, nothing otherwise', () => {
    expect(badgeFor(3, 0)).toEqual({
      text: '3',
      color: '#2563eb',
      title: 'Save to Frameleaf · 3 waiting for your server',
    });
    expect(badgeFor(3, 1)).toEqual({
      text: '!',
      color: '#d97706',
      title: 'Save to Frameleaf · 1 needs you',
    });
    expect(badgeFor(0, 2).title).toBe('Save to Frameleaf · 2 need you');
    expect(badgeFor(150, 0).text).toBe('99+');
    expect(badgeFor(0, 0)).toMatchObject({
      text: '',
      title: 'Save to Frameleaf',
    });
  });
  it('counts both queues and clears when signed out', async () => {
    vi.mocked(listCaptures).mockResolvedValue(
      ['queued', 'uploading', 'committing', 'saved', 'cancelled'].map(
        (state) => ({ state }),
      ) as never,
    );
    vi.mocked(listMediaReceipts).mockResolvedValue([
      { state: 'active' },
      { state: 'saved' },
    ] as never);
    await showBadge(binding);
    expect(action.setBadgeText).toHaveBeenLastCalledWith({ text: '4' });
    expect(action.setBadgeBackgroundColor).toHaveBeenLastCalledWith({
      color: '#2563eb',
    });
    vi.mocked(listMediaReceipts).mockResolvedValue([
      { state: 'paused' },
    ] as never);
    await showBadge(binding);
    expect(action.setBadgeText).toHaveBeenLastCalledWith({ text: '!' });
    expect(action.setTitle).toHaveBeenLastCalledWith({
      title: 'Save to Frameleaf · 1 needs you',
    });
    await showBadge(null);
    expect(action.setBadgeText).toHaveBeenLastCalledWith({ text: '' });
    expect(action.setTitle).toHaveBeenLastCalledWith({
      title: 'Save to Frameleaf',
    });
  });
});
