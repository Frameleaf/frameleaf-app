import { AssetRestorationMode, RestorationStyle, VideoTrimMode, type UserConfigDto } from '@frameleaf/sdk';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { EditingDefaults } from '$lib/frameleaf/editing-defaults.svelte';
import { eventManager } from '$lib/managers/event-manager.svelte';

describe('editing defaults (FL-422)', () => {
  beforeEach(() => {
    sdkMock.getUserConfig.mockReset();
  });

  it('starts where the server does without the settings', async () => {
    sdkMock.getUserConfig.mockRejectedValue(new Error('offline'));
    const defaults = new EditingDefaults();
    await defaults.load();
    expect(defaults.trimMode).toBe('precise');
    expect(defaults.restorationMode).toBe(AssetRestorationMode.Faithful);
  });

  it('reads the server’s choices once', async () => {
    sdkMock.getUserConfig.mockResolvedValue({
      editing: { trimMode: VideoTrimMode.Fast, restoration: { style: RestorationStyle.Creative } },
    } as UserConfigDto);
    const defaults = new EditingDefaults();
    await Promise.all([defaults.load(), defaults.load()]);
    expect(defaults.trimMode).toBe('fast');
    expect(defaults.restorationMode).toBe(AssetRestorationMode.Creative);
    expect(sdkMock.getUserConfig).toHaveBeenCalledTimes(1);
  });

  it('keeps the fallbacks when an older server leaves the settings out', async () => {
    sdkMock.getUserConfig.mockResolvedValue({} as UserConfigDto);
    const defaults = new EditingDefaults();
    await defaults.load();
    expect(defaults.trimMode).toBe('precise');
    expect(defaults.restorationMode).toBe(AssetRestorationMode.Faithful);
  });

  it('follows an administrator’s save in this tab, and forgets them on sign-out', () => {
    const defaults = new EditingDefaults();
    eventManager.emit('SystemConfigUpdate', {
      editing: { trimMode: VideoTrimMode.Fast, restoration: { style: RestorationStyle.Creative } },
    } as never);
    expect(defaults.trimMode).toBe('fast');
    expect(defaults.restorationMode).toBe(AssetRestorationMode.Creative);

    eventManager.emit('AuthLogout');
    expect(defaults.trimMode).toBe('precise');
    expect(defaults.restorationMode).toBe(AssetRestorationMode.Faithful);
  });
});
