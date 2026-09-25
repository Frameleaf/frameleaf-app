import { CloudMlConnection, type AdminConfigDto, type CloudMlStatusResponseDto } from '@immich/sdk';
import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { SystemConfigDraftStore } from '$lib/frameleaf/system-config-draft.svelte';
import en from '../../../../../../i18n/en.json';
import WorkloadRoutingTable from './WorkloadRoutingTable.svelte';

const draftRef = vi.hoisted(() => ({ current: undefined as unknown }));

vi.mock('$lib/managers/feature-flags-manager.svelte', () => ({
  featureFlagsManager: { value: { configFile: false } },
}));
vi.mock('$lib/frameleaf/system-config-draft.svelte', async (original) => ({
  ...(await original<typeof import('$lib/frameleaf/system-config-draft.svelte')>()),
  getSystemConfigDraft: () => draftRef.current,
}));

const config = (enabled: boolean) =>
  ({
    frameleafCloud: {
      cloudMl: {
        enabled,
        routing: {
          descriptions: 'local',
          upscale: 'local',
          restoration: 'local',
          studio: 'local',
          interpolation: 'local',
        },
        startWith: 'local',
        models: { descriptions: '', upscale: '', restoration: '', studio: '', interpolation: '' },
        autoDescribe: { enabled: false, dailyBudgetUsd: 2 },
        faces: { enabled: false },
      },
    },
  }) as unknown as AdminConfigDto;

const useDraft = (enabled: boolean) => {
  const store = new SystemConfigDraftStore(
    { config: config(enabled), revision: 'r1' },
    { defaults: config(false), load: vi.fn(), save: vi.fn() },
  );
  draftRef.current = store;
  return store;
};

const status = (connection: CloudMlConnection) => ({ connection }) as CloudMlStatusResponseDto;

describe('WorkloadRoutingTable (FL-159 §3.2)', () => {
  beforeAll(() => {
    addMessages('dev', en);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    sdkMock.getHardwareCheck.mockRejectedValue(new Error('not checked'));
  });

  it('keeps the cloud choices off until the server is linked and cloud processing is on', async () => {
    useDraft(false);
    sdkMock.getCloudMlStatus.mockResolvedValue(status(CloudMlConnection.NotLinked));
    render(WorkloadRoutingTable);

    expect(
      await screen.findByText(/Link this server to Frameleaf to choose Frameleaf Cloud or both\./),
    ).toBeInTheDocument();
    const descriptions = screen.getByRole('radiogroup', { name: 'Where Descriptions & tags runs' });
    expect(within(descriptions).getByRole('radio', { name: 'Local only' })).toBeEnabled();
    expect(within(descriptions).getByRole('radio', { name: 'Both' })).toBeDisabled();
    expect(within(descriptions).getByRole('radio', { name: 'Cloud only' })).toBeDisabled();
  });

  it('keeps search, faces, text and Studio export on this server with the reason', async () => {
    useDraft(true);
    sdkMock.getCloudMlStatus.mockResolvedValue(status(CloudMlConnection.Ready));
    render(WorkloadRoutingTable);

    for (const name of ['Smart search', 'Face recognition', 'Text in photos', 'Studio export']) {
      const group = await screen.findByRole('radiogroup', { name: `Where ${name} runs` });
      expect(within(group).getByRole('radio', { name: 'Both' })).toBeDisabled();
    }
    expect(screen.getByText('Faces never leave this server.')).toBeInTheDocument();
  });

  it('routes work in the settings draft once cloud processing is on, and sets where jobs start', async () => {
    const store = useDraft(true);
    sdkMock.getCloudMlStatus.mockResolvedValue(status(CloudMlConnection.Ready));
    render(WorkloadRoutingTable);

    const group = await screen.findByRole('radiogroup', { name: 'Where Enhance & upscale runs' });
    const both = within(group).getByRole('radio', { name: 'Both' });
    await vi.waitFor(() => expect(both).toBeEnabled());
    await fireEvent.click(both);
    expect(store.draft.frameleafCloud.cloudMl.routing.upscale).toBe('both');
    expect(both).toHaveAttribute('aria-checked', 'true');

    await fireEvent.change(screen.getByLabelText(/When a job can run in both places, start with/), {
      target: { value: 'cloud' },
    });
    expect(store.draft.frameleafCloud.cloudMl.startWith).toBe('cloud');
  });
});
