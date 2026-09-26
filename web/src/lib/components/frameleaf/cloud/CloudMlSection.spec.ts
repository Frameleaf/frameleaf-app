import {
  CloudMlConnection,
  CloudMlModelGroup,
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
import { handleError } from '$lib/utils/handle-error';
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

const cloudConfig = (enabled = false, modelName?: string) =>
  ({
    ...(modelName && { machineLearning: { imageDescription: { modelName } } }),
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
        autoDescribe: { enabled: false, dailyBudgetUsd: 2 },
        faces: { enabled: false },
      },
    },
  }) as unknown as AdminConfigDto;

const useDraft = (enabled = false, modelName?: string) => {
  const store = new SystemConfigDraftStore(
    { config: cloudConfig(enabled, modelName), revision: 'r1' },
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
  settingsUrl: null,
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

  it('shows the AI Wallet in US dollars and saves a lower daily cap', async () => {
    useDraft(true);
    sdkMock.getCloudMlStatus.mockResolvedValue(status({ enabled: true, consent: consent('2026-10-01') }));
    sdkMock.updateCloudMlWallet.mockResolvedValue({ ...wallet, dailyCapUsd: 15 });
    render(CloudMlSection);

    expect(await screen.findByText('$12.00')).toBeInTheDocument();
    expect(screen.getByText('$10.00 available')).toBeInTheDocument();
    expect(screen.getByText('$5.00 of $20.00 daily cap')).toBeInTheDocument();
    const cap = screen.getByLabelText('Daily spending cap');
    await fireEvent.input(cap, { target: { value: '15' } });
    await fireEvent.change(cap);
    await vi.waitFor(() =>
      expect(sdkMock.updateCloudMlWallet).toHaveBeenCalledWith({ cloudMlWalletUpdateDto: { dailyCapUsd: 15 } }),
    );
  });

  it('sends raising the cap and turning on automatic top-up to the Frameleaf account (FL-177)', async () => {
    useDraft(true);
    const settingsUrl = 'https://account.frameleaf.cloud/wallet';
    sdkMock.getCloudMlStatus.mockResolvedValue(
      status({ enabled: true, consent: consent('2026-10-01'), wallet: { ...wallet, settingsUrl } }),
    );
    render(CloudMlSection);

    const cap = await screen.findByLabelText('Daily spending cap');
    await fireEvent.input(cap, { target: { value: '30' } });
    await fireEvent.change(cap);
    expect(await screen.findByText(/happen in your Frameleaf account/)).toBeInTheDocument();
    expect(sdkMock.updateCloudMlWallet).not.toHaveBeenCalled();
    expect(screen.getByRole('link', { name: /Raise the cap in your Frameleaf account/ })).toHaveAttribute(
      'href',
      settingsUrl,
    );
    expect(screen.getByRole('link', { name: /Turn it on in your Frameleaf account/ })).toHaveAttribute(
      'href',
      settingsUrl,
    );
    expect(screen.getByRole('switch', { name: 'Top up automatically' })).toBeDisabled();
  });

  it('treats any other 403 as a failure, not as a step-up (FL-177 review)', async () => {
    useDraft(true);
    sdkMock.getCloudMlStatus.mockResolvedValue(
      status({ enabled: true, consent: consent('2026-10-01'), wallet: { ...wallet, dailyCapUsd: null } }),
    );
    sdkMock.isHttpError.mockReturnValueOnce(true);
    sdkMock.updateCloudMlWallet.mockRejectedValueOnce({ status: 403, data: { message: 'Forbidden' } });
    render(CloudMlSection);

    const cap = await screen.findByLabelText('Daily spending cap');
    await fireEvent.input(cap, { target: { value: '40' } });
    await fireEvent.change(cap);
    await vi.waitFor(() => expect(handleError).toHaveBeenCalled());
    expect(screen.queryByText(/happen in your Frameleaf account/)).toBeNull();
    expect(sdkMock.getCloudMlWallet).not.toHaveBeenCalled();
  });

  it('turns automatic top-up off from this server', async () => {
    useDraft(true);
    sdkMock.getCloudMlStatus.mockResolvedValue(
      status({ enabled: true, consent: consent('2026-10-01'), wallet: { ...wallet, autoTopUp: true } }),
    );
    sdkMock.updateCloudMlWallet.mockResolvedValue({ ...wallet, autoTopUp: false });
    render(CloudMlSection);

    await fireEvent.click(await screen.findByRole('switch', { name: 'Top up automatically' }));
    await vi.waitFor(() =>
      expect(sdkMock.updateCloudMlWallet).toHaveBeenCalledWith({ cloudMlWalletUpdateDto: { autoTopUp: false } }),
    );
  });

  it('explains a step-up refusal from Frameleaf Cloud instead of failing', async () => {
    useDraft(true);
    sdkMock.getCloudMlStatus.mockResolvedValue(
      status({ enabled: true, consent: consent('2026-10-01'), wallet: { ...wallet, dailyCapUsd: null } }),
    );
    sdkMock.isHttpError.mockReturnValueOnce(true);
    sdkMock.updateCloudMlWallet.mockRejectedValueOnce({
      status: 403,
      data: { message: 'step-up', code: 'step-up-required' },
    });
    sdkMock.getCloudMlWallet.mockResolvedValue({ ...wallet, dailyCapUsd: null });
    render(CloudMlSection);

    const cap = await screen.findByLabelText('Daily spending cap');
    await fireEvent.input(cap, { target: { value: '40' } });
    await fireEvent.change(cap);
    expect(await screen.findByText(/happen in your Frameleaf account/)).toBeInTheDocument();
    expect(sdkMock.getCloudMlWallet).toHaveBeenCalled();
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

  it('chooses the Frameleaf Cloud model of each group from the catalogue and saves it apart from the routes (FL-186)', async () => {
    const store = useDraft(true);
    sdkMock.getCloudMlStatus.mockResolvedValue(status({ enabled: true, consent: consent('2026-10-01') }));
    sdkMock.getCloudMlModelChoices.mockResolvedValue({
      choices: [{ group: CloudMlModelGroup.Descriptions, modelId: null }],
    });
    const entry = {
      workload: MlWorkload.Enrichment,
      group: CloudMlModelGroup.Descriptions,
      description: 'Qwen3.5-9B, L40S-class',
      fingerprint: 'mr_68JDMAM8444M',
      pricingUnit: 'second',
      priceUsd: 0.002,
    };
    sdkMock.getCloudMlCatalog.mockResolvedValue({
      models: [
        { ...entry, id: 'ms_K6WT70CS', name: 'Descriptions · Standard', rank: 2, isDefault: true },
        { ...entry, id: 'ms_M7QG26PT', name: 'Descriptions · Best', rank: 5, isDefault: false },
      ],
    });
    sdkMock.setCloudMlModelChoice.mockResolvedValue({
      choices: [{ group: CloudMlModelGroup.Descriptions, modelId: 'ms_M7QG26PT' }],
    });
    render(CloudMlSection);

    // the Models card names each slider after its work, as in the prototype
    const picker = await screen.findByRole('group', { name: 'Descriptions & tags' });
    expect(within(picker).getByRole('radio', { name: /Descriptions · Standard/ })).toBeChecked();
    // work set to Local only keeps its slider; this catalogue has no upscale model yet
    const upscale = screen.getByRole('group', { name: 'Enhance & upscale' });
    expect(within(upscale).getByText(/Frameleaf Cloud offers no model for this work/)).toBeInTheDocument();

    await fireEvent.click(within(picker).getByRole('radio', { name: /Descriptions · Best/ }));
    await vi.waitFor(() =>
      expect(sdkMock.setCloudMlModelChoice).toHaveBeenCalledWith({
        group: CloudMlModelGroup.Descriptions,
        cloudMlModelChoiceUpdateDto: { modelId: 'ms_M7QG26PT' },
      }),
    );
    expect(within(picker).getByRole('radio', { name: /Descriptions · Best/ })).toBeChecked();
    expect(sdkMock.setMlWorkloadRoute).not.toHaveBeenCalled();
    // a model choice is not a setting: nothing waits for the settings bar
    expect(store.draft.frameleafCloud!.cloudMl).not.toHaveProperty('models');
  });

  it("puts this server's description model on the Models card slider, saved with the settings bar (FL-189)", async () => {
    const store = useDraft(false, 'Qwen/Qwen2.5-VL-3B-Instruct');
    sdkMock.getCloudMlStatus.mockResolvedValue(status({ connection: CloudMlConnection.NotLinked }));
    render(CloudMlSection);

    const picker = await screen.findByRole('group', { name: 'Descriptions & tags' });
    const local = within(picker).getByRole('radiogroup', { name: "This server's model for Descriptions & tags" });
    expect(within(local).getByRole('radio', { name: /^Qwen2\.5-VL 3B/ })).toBeChecked();
    await fireEvent.click(within(local).getByRole('radio', { name: /^Qwen2\.5-VL 7B/ }));
    expect(store.draft.machineLearning.imageDescription?.modelName).toBe('Qwen/Qwen2.5-VL-7B-Instruct');
    expect(sdkMock.setCloudMlModelChoice).not.toHaveBeenCalled();
    // without a Frameleaf Cloud catalogue, kinds of work with no local model have no slider
    expect(screen.queryByRole('group', { name: 'Enhance & upscale' })).toBeNull();
  });

  it('lists recent cloud jobs with GPU time, workers, estimate and settled cost', async () => {
    useDraft(true);
    sdkMock.getCloudMlSettlements.mockResolvedValue({
      items: [
        {
          cloudJobId: 'job-1',
          workload: MlWorkload.RestorationFaithful,
          modelSku: 'realbasicvsr@1',
          computeSku: null,
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
    sdkMock.reconcileCloudMlUsage.mockResolvedValue(undefined as never);
    render(CloudMlSection);

    await vi.waitFor(() => expect(sdkMock.getCloudMlSettlements).toHaveBeenCalled());
    expect(sdkMock.reconcileCloudMlUsage).toHaveBeenCalledTimes(1);
    expect(sdkMock.reconcileCloudMlUsage.mock.invocationCallOrder[0]).toBeLessThan(
      sdkMock.getCloudMlSettlements.mock.invocationCallOrder[0],
    );
  });
});
