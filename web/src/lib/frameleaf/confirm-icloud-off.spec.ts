import { addMessages, init } from 'svelte-i18n';
import en from '../../../../i18n/en.json';
import { confirmICloudOff } from './confirm-icloud-off';

const activity = vi.hoisted(() => vi.fn());
const showDialog = vi.hoisted(() => vi.fn());
vi.mock('@frameleaf/sdk', () => ({ getICloudSyncActivity: activity }));
vi.mock('@frameleaf/ui', () => ({ modalManager: { showDialog } }));

describe(confirmICloudOff.name, () => {
  beforeAll(async () => {
    addMessages('en', en);
    await init({ fallbackLocale: 'en', initialLocale: 'en' });
  });
  beforeEach(() => {
    activity.mockReset();
    showDialog.mockReset();
  });

  it('allows turning off with no dialog when nothing is running', async () => {
    activity.mockResolvedValue({ running: 0 });
    await expect(confirmICloudOff()).resolves.toBe(true);
    expect(showDialog).not.toHaveBeenCalled();
  });

  it.each([true, false])('follows the answer to the warning (%s)', async (answer) => {
    activity.mockResolvedValue({ running: 2 });
    showDialog.mockResolvedValue(answer);
    await expect(confirmICloudOff()).resolves.toBe(answer);
    expect(showDialog.mock.calls[0][0].prompt).toContain('2 iCloud syncs');
  });

  it('allows turning off when the count cannot be read', async () => {
    activity.mockRejectedValue(new Error('offline'));
    await expect(confirmICloudOff()).resolves.toBe(true);
    expect(showDialog).not.toHaveBeenCalled();
  });
});
