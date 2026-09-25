import {
  CloudMlConnection,
  MlWorkload,
  type AdminConfigDto,
  type CloudMlStatusResponseDto,
  type CloudMlWalletDto,
} from '@immich/sdk';
import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { SystemConfigDraftStore } from '$lib/frameleaf/system-config-draft.svelte';
import en from '../../../../../../i18n/en.json';
import CloudMlSection from './CloudMlSection.svelte';

const draftRef = vi.hoisted(() => ({ current: undefined as unknown }));

vi.mock('$lib/utils/handle-error', () => ({ handleError: vi.fn() }));
vi.mock('$lib/managers/feature-flags-manager.svelte', () => ({
  featureFlagsManager: { value: { configFile: false } },
}));
vi.mock('$lib/frameleaf/system-config-draft.svelte', async (original) => ({
  ...(await original<typeof import('$lib/frameleaf/system-config-draft.svelte')>()),
  getSystemConfigDraft: () => draftRef.current,
}));

const cloudConfig = (enabled = false) =>
  ({
    frameleafCloud: {
      cloudMl: {
        enabled,
        routing: {
          descriptions: 'both',
          upscale: 'local',
          restoration: 'local',
          studio: 'local',
          interpolation: 'local',
        },
        startWith: 'local',
        models: {
          descriptions: 'qwen3.5-9b@1',
          upscale: '',
          restoration: '',
          studio: '',
          interpolation: '',
        },
        autoDescribe: { enabled: false, dailyBudgetUsd: 2 },
        faces: { enabled: false },
      },
    },
  }) as unknown as AdminConfigDto;

const useDraft = (enabled = false) => {
  const store = new SystemConfigDraftStore(
    { config: cloudConfig(enabled), revision: 'r1' },
    { defaults: cloudConfig(), load: vi.fn(), save: vi.fn() },
  );
  draftRef.current = store;
  return store;
};

const wallet: CloudMlWalletDto = {
  balanceUsd: 12,
  heldUsd: 2,
  availableUsd: 10,
  dailyCapUsd: 20,
  spentTodayUsd: 5,
  autoTopUp: false,
  topUpUrl: null,
  updatedAt: '2026-09-25T09:00:00.000Z',
};

const consent = (acceptedVersion: string | null) => ({
  requiredVersion: '2026-10-01',
  recordedVersion: acceptedVersion,
  acceptedVersion,
  features: { identityNames: false, medicalSignals: false, ocrAddon: false },
  summary: 'Media is processed in the EU region and deleted after each job.',
  documentUrl: null,
  outdated: false,
});

const status = (overrides: Partial<CloudMlStatusResponseDto> = {}): CloudMlStatusResponseDto => ({
  connection: CloudMlConnection.Ready,
  detail: null,
  enabled: false,
  region: 'eu',
  entitled: true,
  destination: null,
  consent: consent(null),
  wallet,
  checkedAt: '2026-09-25T09:00:00.000Z',
  ...overrides,
});

describe('CloudMlSection (FL-159, prototype Processing)', () => {
  beforeAll(() => {
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.open = true;
    };
    HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
      this.open = false;
    };
    addMessages('dev', en);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    sdkMock.getCloudMlStatus.mockResolvedValue(status());
    sdkMock.getCloudMlSettlements.mockResolvedValue({ items: [] });
    sdkMock.getHardwareCheck.mockRejectedValue(new Error('not checked'));
  });

  it('asks to link the server first and keeps the toggle off until then', async () => {
    useDraft();
    sdkMock.getCloudMlStatus.mockResolvedValue(
      status({ connection: CloudMlConnection.NotLinked, consent: null, wallet: null, region: null }),
    );
    render(CloudMlSection);

    expect(await screen.findByText('Link this server first')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Link to Frameleaf' })).toBeInTheDocument();
    expect(screen.getAllByText('Not linked').length).toBeGreaterThan(0);
    expect(screen.getByRole('switch', { name: 'Use Frameleaf Cloud for chosen jobs' })).toBeDisabled();
  });

  it('shows the terms before turning on, and records the required version only once they are read', async () => {
    const store = useDraft();
    sdkMock.createCloudMlDestination.mockResolvedValue({ id: 'cloud-1' } as never);
    sdkMock.grantMlDestinationConsent.mockResolvedValue({} as never);
    render(CloudMlSection);

    const toggle = await screen.findByRole('switch', { name: 'Use Frameleaf Cloud for chosen jobs' });
    await vi.waitFor(() => expect(toggle).toBeEnabled());
    await fireEvent.click(toggle);

    const dialog = await screen.findByRole('dialog', { name: 'Cloud processing terms · version 2026-10-01' });
    expect(store.draft.frameleafCloud!.cloudMl.enabled).toBe(false);
    expect(within(dialog).getByText("eu · your account's region")).toBeInTheDocument();
    const accept = within(dialog).getByRole('button', { name: 'Accept and turn on' });
    expect(accept).toBeDisabled();
    await fireEvent.click(within(dialog).getByRole('checkbox'));
    await fireEvent.click(accept);

    await vi.waitFor(() => expect(sdkMock.grantMlDestinationConsent).toHaveBeenCalled());
    expect(sdkMock.grantMlDestinationConsent).toHaveBeenCalledWith({
      id: 'cloud-1',
      mlDestinationConsentRequestDto: {
        acknowledgeMediaLeavesNetwork: true,
        version: '2026-10-01',
        features: { identityNames: false, medicalSignals: false, ocrAddon: false },
      },
    });
    expect(store.draft.frameleafCloud!.cloudMl.enabled).toBe(true);
  });

  it('shows the AI Wallet in US dollars and saves a new daily cap', async () => {
    useDraft(true);
    sdkMock.getCloudMlStatus.mockResolvedValue(status({ enabled: true, consent: consent('2026-10-01') }));
    sdkMock.updateCloudMlWallet.mockResolvedValue({ ...wallet, dailyCapUsd: 30 });
    render(CloudMlSection);

    expect(await screen.findByText('$12.00')).toBeInTheDocument();
    expect(screen.getByText('$10.00 available')).toBeInTheDocument();
    expect(screen.getByText('$5.00 of $20.00 daily cap')).toBeInTheDocument();
    const cap = screen.getByLabelText('Daily spending cap');
    await fireEvent.input(cap, { target: { value: '30' } });
    await fireEvent.change(cap);
    await vi.waitFor(() =>
      expect(sdkMock.updateCloudMlWallet).toHaveBeenCalledWith({ cloudMlWalletUpdateDto: { dailyCapUsd: 30 } }),
    );
  });

  it('checks out on frameleaf.cloud only when the cloud returned a top-up address', async () => {
    useDraft(true);
    sdkMock.getCloudMlStatus.mockResolvedValue(
      status({
        enabled: true,
        consent: consent('2026-10-01'),
        wallet: { ...wallet, topUpUrl: 'https://frameleaf.cloud/wallet/top-up' },
      }),
    );
    render(CloudMlSection);

    await fireEvent.click(await screen.findByRole('button', { name: 'Add credit' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add AI credit' });
    await fireEvent.click(within(dialog).getByRole('radio', { name: /\$50\.00/ }));
    expect(within(dialog).getByRole('link', { name: /Continue on frameleaf\.cloud/ })).toHaveAttribute(
      'href',
      'https://frameleaf.cloud/wallet/top-up?amount=50',
    );
  });

  it('estimates a job and says whether it could start now', async () => {
    useDraft(true);
    sdkMock.getCloudMlStatus.mockResolvedValue(status({ enabled: true, consent: consent('2026-10-01') }));
    render(CloudMlSection);

    expect(await screen.findByText('This job could start now.')).toBeInTheDocument();
    expect(screen.getByText(/^Likely \$0\.\d+, at most about \$0\.\d+/)).toBeInTheDocument();
    await fireEvent.input(screen.getByLabelText(/Quantity/), { target: { value: '100000' } });
    expect(await screen.findByText(/Would be refused: Add AI credit/)).toBeInTheDocument();
  });

  it('chooses the model for each kind of work in the settings draft', async () => {
    const store = useDraft(true);
    sdkMock.getCloudMlStatus.mockResolvedValue(status({ enabled: true, consent: consent('2026-10-01') }));
    render(CloudMlSection);

    const slider = await screen.findByRole('group', { name: 'Descriptions & tags' });
    const radios = within(slider).getAllByRole('radio');
    const heaviest = radios.findLast((radio) => !(radio as HTMLInputElement).disabled) as HTMLInputElement;
    await fireEvent.click(heaviest);
    expect(store.draft.frameleafCloud!.cloudMl.models.descriptions).toBe(heaviest.value);
  });

  it('lists recent cloud jobs with GPU time, workers, estimate and settled cost', async () => {
    useDraft(true);
    sdkMock.getCloudMlSettlements.mockResolvedValue({
      items: [
        {
          cloudJobId: 'job-1',
          workload: MlWorkload.RestorationFaithful,
          modelId: 'realbasicvsr@1',
          succeeded: true,
          costUsd: 2.21,
          estimateUsd: 2.26,
          gpuSeconds: 540,
          workers: 5,
          credits: null,
          jobName: null,
          finishedAt: '2026-09-25T08:00:00.000Z',
        },
      ],
    });
    render(CloudMlSection);

    const table = await screen.findByRole('table');
    const row = within(table).getAllByRole('row')[1];
    expect(within(row).getByText('$2.26')).toBeInTheDocument();
    expect(within(row).getByText(/\$2\.21/)).toBeInTheDocument();
    expect(within(row).getByText(/9 min GPU time · 5 workers/)).toBeInTheDocument();
    expect(within(row).getByText('Completed')).toBeInTheDocument();
  });

  it('applies settled charges with the explicit usage refresh before listing them', async () => {
    useDraft(true);
    sdkMock.getCloudMlStatus.mockResolvedValue(
      status({ enabled: true, consent: consent('2026-10-01'), destination: { id: 'cloud-1' } as never }),
    );
    sdkMock.reconcileCloudMlUsage.mockResolvedValue();
    render(CloudMlSection);

    await vi.waitFor(() => expect(sdkMock.getCloudMlSettlements).toHaveBeenCalled());
    expect(sdkMock.reconcileCloudMlUsage).toHaveBeenCalledTimes(1);
    expect(sdkMock.reconcileCloudMlUsage.mock.invocationCallOrder[0]).toBeLessThan(
      sdkMock.getCloudMlSettlements.mock.invocationCallOrder[0],
    );
  });
});
