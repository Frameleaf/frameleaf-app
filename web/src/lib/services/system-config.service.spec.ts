import { getConfig, updateConfig, type AdminConfigDto } from '@frameleaf/sdk';
import { toastManager } from '@frameleaf/ui';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { handleSystemConfigSave } from '$lib/services/system-config.service';
import { handleError } from '$lib/utils/handle-error';

vi.mock('@frameleaf/sdk', async (original) => ({
  ...(await original<typeof import('@frameleaf/sdk')>()),
  getConfig: vi.fn(),
  updateConfig: vi.fn(),
}));
vi.mock('$lib/utils/i18n', async (original) => ({
  ...(await original<typeof import('$lib/utils/i18n')>()),
  getFormatter: () => Promise.resolve((key: string) => key),
}));
vi.mock('$lib/utils/handle-error', () => ({ handleError: vi.fn() }));

const saved = { storageTemplate: { enabled: false, template: '{{y}}/{{filename}}' } } as unknown as AdminConfigDto;
const change = { storageTemplate: { enabled: true, template: '{{y}}/{{filename}}' } } as Partial<AdminConfigDto>;

describe('handleSystemConfigSave', () => {
  beforeEach(() => {
    vi.mocked(getConfig).mockReset().mockResolvedValue(saved);
    vi.mocked(updateConfig).mockReset();
    vi.mocked(handleError).mockReset();
    vi.spyOn(toastManager, 'primary').mockImplementation(() => undefined as never);
    vi.spyOn(eventManager, 'emit').mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('saves a change, says so, and resolves true', async () => {
    const next = { ...saved, ...change } as AdminConfigDto;
    vi.mocked(updateConfig).mockResolvedValue(next);

    await expect(handleSystemConfigSave(change)).resolves.toBe(true);

    expect(updateConfig).toHaveBeenCalledExactlyOnceWith({ adminConfigDto: next });
    expect(eventManager.emit).toHaveBeenCalledExactlyOnceWith('SystemConfigUpdate', next);
    expect(toastManager.primary).toHaveBeenCalledExactlyOnceWith('settings_saved');
    expect(handleError).not.toHaveBeenCalled();
  });

  it('saves without the toast when the caller reports the result itself', async () => {
    const next = { ...saved, ...change } as AdminConfigDto;
    vi.mocked(updateConfig).mockResolvedValue(next);

    await expect(handleSystemConfigSave(change, { notifySaved: false })).resolves.toBe(true);

    expect(updateConfig).toHaveBeenCalledOnce();
    expect(eventManager.emit).toHaveBeenCalledExactlyOnceWith('SystemConfigUpdate', next);
    expect(toastManager.primary).not.toHaveBeenCalled();
  });

  it('resolves false when the save is refused, after the failure message', async () => {
    const refused = new Error('refused');
    vi.mocked(updateConfig).mockRejectedValue(refused);

    await expect(handleSystemConfigSave(change)).resolves.toBe(false);

    expect(handleError).toHaveBeenCalledExactlyOnceWith(refused, 'errors.unable_to_save_settings');
    expect(toastManager.primary).not.toHaveBeenCalled();
    expect(eventManager.emit).not.toHaveBeenCalled();
  });

  it('still reports a refused save when the saved toast is turned off', async () => {
    vi.mocked(updateConfig).mockRejectedValue(new Error('refused'));

    await expect(handleSystemConfigSave(change, { notifySaved: false })).resolves.toBe(false);

    expect(handleError).toHaveBeenCalledOnce();
  });

  it('resolves true without saving when nothing would change', async () => {
    await expect(handleSystemConfigSave({ storageTemplate: saved.storageTemplate })).resolves.toBe(true);

    expect(updateConfig).not.toHaveBeenCalled();
    expect(toastManager.primary).not.toHaveBeenCalled();
  });

  it('still rejects when the current settings cannot be read', async () => {
    vi.mocked(getConfig).mockRejectedValue(new Error('offline'));

    await expect(handleSystemConfigSave(change)).rejects.toThrow('offline');
    expect(updateConfig).not.toHaveBeenCalled();
  });
});
