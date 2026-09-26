import {
  CloudMlConnection,
  CloudMlModelGroup,
  MlWorkload,
  type AdminConfigDto,
  type CloudMlModelChoiceDto,
  type CloudMlModelDto,
  type CloudMlStatusResponseDto,
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
/** Frameleaf Cloud linked and answering. */
const cloudReady = () => ({ connection: CloudMlConnection.Ready, destination: null }) as CloudMlStatusResponseDto;

const model = (
  id: string,
  workload: MlWorkload,
  group: CloudMlModelGroup,
  name: string,
  rank: number,
  isDefault = false,
): CloudMlModelDto => ({
  id,
  workload,
  group,
  name,
  rank,
  isDefault,
  description: `${name} model, H200-class`,
  fingerprint: 'mr_68JDMAM8444M',
  pricingUnit: 'second',
  priceUsd: 0.001,
});

const catalog: CloudMlModelDto[] = [
  model('ms_DESCBEST', MlWorkload.Enrichment, CloudMlModelGroup.Descriptions, 'Descriptions · Best', 2),
  model('ms_DESCFAST', MlWorkload.Enrichment, CloudMlModelGroup.Descriptions, 'Descriptions · Fast', 1, true),
  model('ms_DESCHUGE', MlWorkload.Enrichment, CloudMlModelGroup.Descriptions, 'Descriptions · Huge', 3),
  model(
    'ms_RESTFAIT',
    MlWorkload.RestorationFaithful,
    CloudMlModelGroup.RestorationFaithful,
    'Restoration · Faithful',
    1,
    true,
  ),
  model(
    'ms_RESTCREA',
    MlWorkload.RestorationCreative,
    CloudMlModelGroup.RestorationCreative,
    'Restoration · Creative',
    1,
  ),
  // Frameleaf Cloud never marks a Studio AI default; were one marked, it is still not used.
  model('ms_STUDIOWD', MlWorkload.StudioAi, CloudMlModelGroup.Transcription, 'Studio · Words', 1, true),
  model('ms_STUDIOVO', MlWorkload.StudioAi, CloudMlModelGroup.Tts, 'Studio · Voice', 1),
];

const choice = (group: CloudMlModelGroup, modelId: string | null = null): CloudMlModelChoiceDto => ({
  group,
  modelId,
});

const useCloudModels = (choices: CloudMlModelChoiceDto[] = []) => {
  sdkMock.getCloudMlStatus.mockResolvedValue(cloudReady());
  sdkMock.getCloudMlModelChoices.mockResolvedValue({ choices });
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

  describe('Frameleaf Cloud model per model group (FL-186)', () => {
    it('lists the catalogue models of a group, uses the recommended one, and saves a chosen SKU on its own', async () => {
      useDraft(true, { descriptions: 'both' });
      useCloudModels();
      sdkMock.setCloudMlModelChoice
        .mockResolvedValueOnce({ choices: [choice(CloudMlModelGroup.Descriptions, 'ms_DESCBEST')] })
        .mockResolvedValueOnce({ choices: [choice(CloudMlModelGroup.Descriptions)] });
      render(WorkloadRoutingTable);

      const group = await screen.findByRole('group', { name: 'Frameleaf Cloud model for Descriptions & tags' });
      // lightest first, only this group's models
      expect(radioValues(group)).toEqual(['ms_DESCFAST', 'ms_DESCBEST', 'ms_DESCHUGE']);
      expect(within(group).getByRole('radio', { name: /Descriptions · Fast: .*Recommended/ })).toBeChecked();
      expect(within(group).getByText(/Used until you choose another model\./)).toBeInTheDocument();
      expect(within(group).getAllByText(/\$0\.0600 per minute of GPU time/).length).toBeGreaterThan(0);
      // work set to Local only has no cloud model to choose
      expect(screen.queryByRole('group', { name: 'Frameleaf Cloud model for Enhance & upscale' })).toBeNull();

      await fireEvent.click(within(group).getByRole('radio', { name: /Descriptions · Best/ }));
      // the choice shows at once, and the group stays usable while it is saved
      expect(within(group).getByRole('radio', { name: /Descriptions · Best/ })).toBeChecked();
      expect(group).not.toBeDisabled();
      await vi.waitFor(() =>
        expect(sdkMock.setCloudMlModelChoice).toHaveBeenCalledWith({
          group: CloudMlModelGroup.Descriptions,
          cloudMlModelChoiceUpdateDto: { modelId: 'ms_DESCBEST' },
        }),
      );
      expect(
        await screen.findByText(
          'Descriptions & tags now uses Descriptions · Best on Frameleaf Cloud. Each job still shows its cost first.',
        ),
      ).toBeInTheDocument();
      // the choice is not the route: no route is written
      expect(sdkMock.setMlWorkloadRoute).not.toHaveBeenCalled();

      await fireEvent.click(
        within(group).getByRole('button', { name: 'Use the recommended model (Descriptions · Fast)' }),
      );
      await vi.waitFor(() =>
        expect(sdkMock.setCloudMlModelChoice).toHaveBeenLastCalledWith({
          group: CloudMlModelGroup.Descriptions,
          cloudMlModelChoiceUpdateDto: { modelId: null },
        }),
      );
      expect(
        await screen.findByText('Descriptions & tags now uses the model Frameleaf Cloud recommends.'),
      ).toBeInTheDocument();
    });

    it('saves only the latest of several quick choices, so arrow keys move freely', async () => {
      useDraft(true, { descriptions: 'cloud' });
      useCloudModels();
      sdkMock.setCloudMlModelChoice.mockResolvedValue({
        choices: [choice(CloudMlModelGroup.Descriptions, 'ms_DESCHUGE')],
      });
      render(WorkloadRoutingTable);

      const group = await screen.findByRole('group', { name: 'Frameleaf Cloud model for Descriptions & tags' });
      await fireEvent.click(within(group).getByRole('radio', { name: /Descriptions · Best/ }));
      await fireEvent.click(within(group).getByRole('radio', { name: /Descriptions · Huge/ }));

      await vi.waitFor(() => expect(sdkMock.setCloudMlModelChoice).toHaveBeenCalled());
      expect(sdkMock.setCloudMlModelChoice).toHaveBeenCalledTimes(1);
      expect(sdkMock.setCloudMlModelChoice).toHaveBeenCalledWith({
        group: CloudMlModelGroup.Descriptions,
        cloudMlModelChoiceUpdateDto: { modelId: 'ms_DESCHUGE' },
      });
    });

    it('offers the chosen cloud model for a Both workload whatever its route, restoration per mode', async () => {
      // No route points at Frameleaf Cloud: a job the person sends there still uses these choices.
      useDraft(true, { restoration: 'both' });
      useCloudModels([choice(CloudMlModelGroup.RestorationFaithful, 'ms_RESTFAIT')]);
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
      expect(sdkMock.getMlWorkloadRoutes).not.toHaveBeenCalled();
    });

    it('gives Studio AI a speech to text and a speech model, and always asks for them', async () => {
      useDraft(true, { studio: 'cloud' });
      useCloudModels([choice(CloudMlModelGroup.Tts, 'ms_STUDIOVO')]);
      render(WorkloadRoutingTable);

      const words = await screen.findByRole('group', {
        name: 'Frameleaf Cloud model for Speech to text and captions',
      });
      const voice = screen.getByRole('group', { name: 'Frameleaf Cloud model for Speech' });
      expect(radioValues(words)).toEqual(['ms_STUDIOWD']);
      expect(radioValues(voice)).toEqual(['ms_STUDIOVO']);
      expect(within(voice).getByRole('radio')).toBeChecked();
      expect(within(words).getByRole('radio')).not.toBeChecked();
      expect(within(words).getByText(/^Choose a Frameleaf Cloud model for Studio AI\./)).toBeInTheDocument();
    });

    it('reads the catalogue once cloud processing is turned on on this page', async () => {
      const store = useDraft(false, { descriptions: 'both' });
      useCloudModels();
      render(WorkloadRoutingTable);

      await vi.waitFor(() => expect(sdkMock.getCloudMlStatus).toHaveBeenCalled());
      expect(sdkMock.getCloudMlCatalog).not.toHaveBeenCalled();
      store.draft.frameleafCloud!.cloudMl.enabled = true;
      expect(
        await screen.findByRole('group', { name: 'Frameleaf Cloud model for Descriptions & tags' }),
      ).toBeInTheDocument();
      expect(sdkMock.getCloudMlCatalog).toHaveBeenCalledTimes(1);
    });

    it('says when the Frameleaf Cloud model list cannot be read', async () => {
      useDraft(true, { descriptions: 'cloud' });
      useCloudModels();
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
