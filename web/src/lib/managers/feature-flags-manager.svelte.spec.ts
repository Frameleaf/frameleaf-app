import { sdkMock } from '$lib/__mocks__/sdk.mock';

const flags = (supporter: boolean) => ({ supporter, map: true }) as never;

describe('feature flags manager', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('reads the flags at start when nothing read them yet', async () => {
    sdkMock.getServerFeatures.mockResolvedValue(flags(false));
    const { featureFlagsManager } = await import('$lib/managers/feature-flags-manager.svelte');
    await featureFlagsManager.init();
    expect(sdkMock.getServerFeatures).toHaveBeenCalledTimes(1);
    expect(featureFlagsManager.value).toEqual(flags(false));
  });

  it('starts from the flags sign-in already read instead of asking again', async () => {
    const { featureFlagsManager } = await import('$lib/managers/feature-flags-manager.svelte');
    const { eventManager: events } = await import('$lib/managers/event-manager.svelte');
    events.emit('ServerFeaturesLoaded', flags(true));
    await featureFlagsManager.init();
    expect(sdkMock.getServerFeatures).not.toHaveBeenCalled();
    expect(featureFlagsManager.value).toEqual(flags(true));
  });

  it('keeps a refresh newer than the sign-in answer that arrives after it', async () => {
    sdkMock.getServerFeatures.mockResolvedValue(flags(false));
    const { featureFlagsManager } = await import('$lib/managers/feature-flags-manager.svelte');
    const { eventManager: events } = await import('$lib/managers/event-manager.svelte');
    events.emit('FrameleafCloudUpdate', { topic: 'link' });
    await vi.waitFor(() => expect(featureFlagsManager.value).toEqual(flags(false)));
    events.emit('ServerFeaturesLoaded', flags(true));
    expect(featureFlagsManager.value).toEqual(flags(false));
  });
});
