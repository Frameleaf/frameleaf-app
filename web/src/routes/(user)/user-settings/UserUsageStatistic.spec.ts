import { render, screen, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import en from '../../../../../i18n/en.json';
import UserUsageStatistic from './UserUsageStatistic.svelte';

const account = vi.hoisted(() => ({ user: { quotaUsageInBytes: 2e9, quotaSizeInBytes: 10e9 } }));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('$lib/managers/auth-manager.svelte', () => ({ authManager: account }));

const stats = (total: number) => ({ images: total, videos: 0, total }) as never;
const heatmap = (totalCount: number) =>
  ({ from: '2025-10-17', to: '2026-10-16', totalCount, series: [{ date: '2026-10-16', count: totalCount }] }) as never;

describe('UserUsageStatistic: Your library in numbers (ACCOUNT-P7)', () => {
  beforeAll(() => {
    addMessages('dev', en);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    account.user = { quotaUsageInBytes: 2e9, quotaSizeInBytes: 10e9 };
    sdkMock.getAssetStatistics.mockResolvedValue(stats(12));
    sdkMock.getAlbumStatistics.mockResolvedValue({ owned: 2, shared: 1, notShared: 1 } as never);
    sdkMock.getMyCalendarHeatmap.mockImplementation(({ $type }) =>
      Promise.resolve(heatmap($type === 'Upload' ? 232 : 46)),
    );
  });

  it('says each year grid’s total and how to read it under its title', async () => {
    render(UserUsageStatistic);

    expect(await screen.findByText('232 added this year. Each square is a day; darker means more.')).toBeVisible();
    expect(
      screen.getByText('46 taken this year. Older photos you added this year count on the day they were taken.'),
    ).toBeVisible();
  });

  it('shows "Room on this server" as its own group only when a limit is set', async () => {
    const { unmount } = render(UserUsageStatistic);
    const room = (await screen.findByRole('heading', { name: 'Room on this server' })).closest('section')!;
    expect(within(room).getByRole('meter', { name: 'Room used' })).toHaveAttribute('aria-valuenow', '20');
    unmount();

    account.user = { quotaUsageInBytes: 2e9, quotaSizeInBytes: 0 };
    render(UserUsageStatistic);
    await screen.findAllByText(/added this year/);
    expect(screen.queryByRole('heading', { name: 'Room on this server' })).toBeNull();
  });
});
