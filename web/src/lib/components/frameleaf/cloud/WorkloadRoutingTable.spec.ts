import {
  CloudMlConnection,
  MlWorkload,
  type AdminConfigDto,
  type CloudMlModelDto,
  type CloudMlStatusResponseDto,
  type MlWorkloadRouteDto,
} from '@immich/sdk';
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

type Routing = Record<'descriptions' | 'upscale' | 'restoration' | 'studio' | 'interpolation', string>;

const config = (enabled: boolean, routing: Partial<Routing> = {}) =>
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
          ...routing,
        },
        startWith: 'local',
        autoDescribe: { enabled: false, dailyBudgetUsd: 2 },
        faces: { enabled: false },
      },
    },
  }) as unknown as AdminConfigDto;

const useDraft = (enabled: boolean, routing: Partial<Routing> = {}) => {
  const store = new SystemConfigDraftStore(
    { config: config(enabled, routing), revision: 'r1' },
    { defaults: config(false), load: vi.fn(), save: vi.fn() },
  );
  draftRef.current = store;
  return store;
};

const status = (connection: CloudMlConnection) => ({ connection }) as CloudMlStatusResponseDto;
/** Frameleaf Cloud ready and added as the destination `cloud-1`. */
const cloudReady = () =>
  ({ connection: CloudMlConnection.Ready, destination: { id: 'cloud-1' } }) as CloudMlStatusResponseDto;

const model = (id: string, workload: MlWorkload, name: string, rank: number, isDefault = false): CloudMlModelDto => ({
  id,
  workload,
  name,
  rank,
  isDefault,
  description: `${name} model, H200-class`,
  fingerprint: 'mr_68JDMAM8444M',
  pricingUnit: 'second',
  priceUsd: 0.001,
});

const catalog: CloudMlModelDto[] = [
  model('ms_DESCBEST', MlWorkload.Enrichment, 'Descriptions · Best', 2),
  model('ms_DESCFAST', MlWorkload.Enrichment, 'Descriptions · Fast', 1, true),
  model('ms_RESTFAIT', MlWorkload.RestorationFaithful, 'Restoration · Faithful', 1, true),
  model('ms_RESTCREA', MlWorkload.RestorationCreative, 'Restoration · Creative', 1),
  // Frameleaf Cloud never marks a Studio AI default; were one marked, it is still not used.
  model('ms_STUDIOVO', MlWorkload.StudioAi, 'Studio · Voice', 1, true),
];

const route = (
  workload: MlWorkload,
  destinationId: string | null,
  modelId: string | null = null,
): MlWorkloadRouteDto => ({
  workload,
  destinationId,
  modelId,
});

const useCloudModels = (routes: MlWorkloadRouteDto[]) => {
  sdkMock.getCloudMlStatus.mockResolvedValue(cloudReady());
  sdkMock.getMlWorkloadRoutes.mockResolvedValue({ routes });
  sdkMock.getCloudMlCatalog.mockResolvedValue({ models: catalog });
};

const radioValues = (group: HTMLElement) =>
  within(group)
    .getAllByRole('radio')
    .map((radio) => (radio as HTMLInputElement).value);

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
    expect(store.draft.frameleafCloud!.cloudMl.routing.upscale).toBe('both');
    expect(both).toHaveAttribute('aria-checked', 'true');

    await fireEvent.change(screen.getByLabelText(/When a job can run in both places, start with/), {
      target: { value: 'cloud' },
    });
    expect(store.draft.frameleafCloud!.cloudMl.startWith).toBe('cloud');
  });

  describe('Frameleaf Cloud model per workload (FL-186)', () => {
    it('lists the catalogue models of a cloud-routed workload, uses the recommended one, and saves a chosen SKU', async () => {
      useDraft(true, { descriptions: 'both' });
      useCloudModels([route(MlWorkload.Enrichment, 'cloud-1')]);
      sdkMock.setMlWorkloadRoute
        .mockResolvedValueOnce({ routes: [route(MlWorkload.Enrichment, 'cloud-1', 'ms_DESCBEST')] })
        .mockResolvedValueOnce({ routes: [route(MlWorkload.Enrichment, 'cloud-1')] });
      render(WorkloadRoutingTable);

      const group = await screen.findByRole('group', { name: 'Frameleaf Cloud model for Descriptions & tags' });
      // lightest first, only this workload's models
      expect(radioValues(group)).toEqual(['ms_DESCFAST', 'ms_DESCBEST']);
      expect(within(group).getByRole('radio', { name: /Descriptions · Fast: .*Recommended/ })).toBeChecked();
      expect(within(group).getByText(/Used until you choose another model\./)).toBeInTheDocument();
      expect(within(group).getAllByText(/\$0\.0600 per minute of GPU time/).length).toBeGreaterThan(0);
      // work set to Local only has no cloud model to choose
      expect(screen.queryByRole('group', { name: 'Frameleaf Cloud model for Enhance & upscale' })).toBeNull();

      await fireEvent.click(within(group).getByRole('radio', { name: /Descriptions · Best/ }));
      expect(sdkMock.setMlWorkloadRoute).toHaveBeenCalledWith({
        workload: MlWorkload.Enrichment,
        mlWorkloadRouteUpdateDto: { destinationId: 'cloud-1', modelId: 'ms_DESCBEST' },
      });
      expect(
        await screen.findByText(
          'Descriptions & tags now uses Descriptions · Best on Frameleaf Cloud. Each job still shows its cost first.',
        ),
      ).toBeInTheDocument();
      expect(within(group).getByRole('radio', { name: /Descriptions · Best/ })).toBeChecked();

      await fireEvent.click(
        within(group).getByRole('button', { name: 'Use the recommended model (Descriptions · Fast)' }),
      );
      expect(sdkMock.setMlWorkloadRoute).toHaveBeenLastCalledWith({
        workload: MlWorkload.Enrichment,
        mlWorkloadRouteUpdateDto: { destinationId: 'cloud-1', modelId: null },
      });
      expect(
        await screen.findByText('Descriptions & tags now uses the model Frameleaf Cloud recommends.'),
      ).toBeInTheDocument();
    });

    it('gives faithful and creative restoration their own pickers, each with only its own mode', async () => {
      useDraft(true, { restoration: 'cloud' });
      useCloudModels([
        route(MlWorkload.RestorationFaithful, 'cloud-1'),
        route(MlWorkload.RestorationCreative, 'cloud-1'),
      ]);
      render(WorkloadRoutingTable);

      const faithful = await screen.findByRole('group', { name: 'Frameleaf Cloud model for Restoration (faithful)' });
      const creative = screen.getByRole('group', { name: 'Frameleaf Cloud model for Restoration (creative)' });
      expect(radioValues(faithful)).toEqual(['ms_RESTFAIT']);
      expect(radioValues(creative)).toEqual(['ms_RESTCREA']);
      expect(within(faithful).getByRole('radio')).toBeChecked();
      // the faithful recommendation never stands in for creative work: the picker asks for a choice
      expect(within(creative).getByRole('radio')).not.toBeChecked();
      expect(
        within(creative).getByText(
          'Frameleaf Cloud recommends no model for this work in this region. Choose one; these jobs are refused until you do.',
        ),
      ).toBeInTheDocument();
    });

    it('always asks for a Studio AI model, and asks to route work to Frameleaf Cloud before choosing one', async () => {
      useDraft(true, { studio: 'cloud', interpolation: 'both' });
      useCloudModels([route(MlWorkload.StudioAi, 'cloud-1'), route(MlWorkload.Interpolation, 'lan-1')]);
      render(WorkloadRoutingTable);

      const studio = await screen.findByRole('group', { name: 'Frameleaf Cloud model for Transcripts & captions' });
      expect(within(studio).getByRole('radio')).not.toBeChecked();
      expect(within(studio).getByText(/^Choose a Frameleaf Cloud model for Studio AI\./)).toBeInTheDocument();
      expect(
        screen.getByText('Route Smooth motion to Frameleaf Cloud in Processing destinations to choose its model.'),
      ).toBeInTheDocument();
    });

    it('says when the Frameleaf Cloud model list cannot be read', async () => {
      useDraft(true, { descriptions: 'cloud' });
      useCloudModels([route(MlWorkload.Enrichment, 'cloud-1')]);
      sdkMock.getCloudMlCatalog.mockRejectedValue(new Error('unavailable'));
      render(WorkloadRoutingTable);

      expect(
        await screen.findByText(
          'The Frameleaf Cloud model list could not be read. Check the connection in Cloud processing.',
        ),
      ).toBeInTheDocument();
      expect(screen.queryByRole('group', { name: /Frameleaf Cloud model for/ })).toBeNull();
    });
  });
});
