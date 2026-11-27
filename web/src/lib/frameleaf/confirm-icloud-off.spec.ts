import { addMessages, init } from 'svelte-i18n';
import en from '../../../../i18n/en.json';
import { confirmICloudOff } from './confirm-icloud-off';

const activity = vi.hoisted(() => vi.fn());
const show = vi.hoisted(() => vi.fn());
vi.mock('@frameleaf/sdk', () => ({ getICloudSyncActivity: activity }));
// FL-1814: the warning is the shared confirm dialog, opened through confirmFrameleaf
vi.mock('$lib/frameleaf/confirm', () => ({ confirmFrameleaf: show }));

describe(confirmICloudOff.name, () => {
  beforeAll(async () => {
    addMessages('en', en);
    await init({ fallbackLocale: 'en', initialLocale: 'en' });
  });
  beforeEach(() => {
    activity.mockReset();
    show.mockReset();
  });

  it('allows turning off with no dialog when nothing is running', async () => {
    activity.mockResolvedValue({ running: 0 });
    await expect(confirmICloudOff()).resolves.toBe(true);
    expect(show).not.toHaveBeenCalled();
  });

  it.each([true, false])('follows the answer to the warning (%s)', async (answer) => {
    activity.mockResolvedValue({ running: 2 });
    show.mockResolvedValue(answer);
    await expect(confirmICloudOff()).resolves.toBe(answer);
    expect(show.mock.calls[0][0].prompt).toContain('2 iCloud syncs');
    expect(show.mock.calls[0][0]).toMatchObject({ danger: true });
  });

  it('allows turning off when the count cannot be read', async () => {
    activity.mockRejectedValue(new Error('offline'));
    await expect(confirmICloudOff()).resolves.toBe(true);
    expect(show).not.toHaveBeenCalled();
  });
});
