import {
  CloudMlConnection,
  CloudMlModelGroup,
  MlWorkload,
  type AdminConfigDto,
  type CloudMlModelChoiceDto,
  type CloudMlModelChoicesResponseDto,
  type CloudMlModelDto,
  type CloudMlStatusResponseDto,
  type HardwareCheckResponseDto,
} from '@immich/sdk';
import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { SystemConfigDraftStore } from '$lib/frameleaf/system-config-draft.svelte';
import { handleError } from '$lib/utils/handle-error';
import en from '../../../../../../i18n/en.json';
import WorkloadRoutingTable from './WorkloadRoutingTable.svelte';

const draftRef = vi.hoisted(() => ({ current: undefined as unknown }));

vi.mock('$lib/utils/handle-error', () => ({ handleError: vi.fn() }));
vi.mock('$lib/managers/feature-flags-manager.svelte', () => ({
  featureFlagsManager: { value: { configFile: false } },
}));
vi.mock('$lib/frameleaf/system-config-draft.svelte', async (original) => ({
  ...(await original<typeof import('$lib/frameleaf/system-config-draft.svelte')>()),
  getSystemConfigDraft: () => draftRef.current,
}));

type Routing = Record<'descriptions' | 'upscale' | 'restoration' | 'studio' | 'interpolation', string>;

const config = (enabled: boolean, routing: Partial<Routing> = {}, modelName?: string) =>
  ({
    ...(modelName && { machineLearning: { imageDescription: { modelName } } }),
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

const useDraft = (enabled: boolean, routing: Partial<Routing> = {}, modelName?: string) => {
  const store = new SystemConfigDraftStore(
    { config: config(enabled, routing, modelName), revision: 'r1' },
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

/** One slider per model group, named "Model for …" as in the prototype. */
const findPicker = (name: string) => screen.findByRole('group', { name: `Model for ${name}` });
/** The Frameleaf Cloud (blue) stops of a slider. */
const cloudStops = (picker: HTMLElement, name: string) =>
  within(picker).getByRole('radiogroup', { name: `Frameleaf Cloud model for ${name}` });
/** This server's (white and green) stops of a slider. */
const localStopsOf = (picker: HTMLElement) =>
  within(picker).getByRole('radiogroup', { name: "This server's model for Descriptions & tags" });

const hardwareCheck = (ml: Partial<HardwareCheckResponseDto['ml']>) =>
  ({
    checkedAt: '2026-09-26T09:00:00.000Z',
    server: { reachable: true, vendor: null, model: null, vramGb: null, driver: null, backend: 'CPU', test: null },
    ml: {
      reachable: true,
      vendor: 'NVIDIA',
      model: 'NVIDIA GeForce RTX 3060',
      vramGb: 12,
      driver: '550',
      backend: 'CUDA',
      test: null,
      ...ml,
    },
    mlImage: 'cuda',
    issues: [],
    benchmark: null,
  }) as HardwareCheckResponseDto;

const LOCAL_MODELS = [
  'microsoft/Florence-2-base-ft',
  'microsoft/Florence-2-large-ft',
  'Qwen/Qwen2.5-VL-3B-Instruct',
  'Qwen/Qwen2.5-VL-7B-Instruct',
  'Qwen/Qwen3-VL-30B-A3B-Instruct',
  'Qwen/Qwen2.5-VL-32B-Instruct',
  'Qwen/Qwen2.5-VL-72B-Instruct',
];

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

      const group = await findPicker('descriptions & tags');
      // lightest first, only this group's models
      expect(radioValues(cloudStops(group, 'Descriptions & tags'))).toEqual([
        'ms_DESCFAST',
        'ms_DESCBEST',
        'ms_DESCHUGE',
      ]);
      expect(within(group).getByRole('radio', { name: /Descriptions · Fast: .*Recommended/ })).toBeChecked();
      expect(within(group).getByText(/Used until you choose another model\./)).toBeInTheDocument();
      expect(within(group).getAllByText(/\$0\.0600 per minute of GPU time/).length).toBeGreaterThan(0);
      // work set to Local only still has its slider (prototype); this catalogue has no upscale model yet
      const upscale = await findPicker('enhance & upscale');
      expect(within(upscale).getByText(/Frameleaf Cloud offers no model for this work/)).toBeInTheDocument();
      expect(within(upscale).queryAllByRole('radio')).toEqual([]);

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
      // the button goes away, so focus moves to the recommended model instead of dropping
      await vi.waitFor(() => expect(within(group).getByRole('radio', { name: /Descriptions · Fast/ })).toHaveFocus());
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

      const group = await findPicker('descriptions & tags');
      await fireEvent.click(within(group).getByRole('radio', { name: /Descriptions · Best/ }));
      await fireEvent.click(within(group).getByRole('radio', { name: /Descriptions · Huge/ }));

      await vi.waitFor(() => expect(sdkMock.setCloudMlModelChoice).toHaveBeenCalled());
      expect(sdkMock.setCloudMlModelChoice).toHaveBeenCalledTimes(1);
      expect(sdkMock.setCloudMlModelChoice).toHaveBeenCalledWith({
        group: CloudMlModelGroup.Descriptions,
        cloudMlModelChoiceUpdateDto: { modelId: 'ms_DESCHUGE' },
      });
    });

    it('keeps a newer choice made while a failed save was in flight, and saves it next', async () => {
      useDraft(true, { descriptions: 'cloud' });
      useCloudModels();
      let rejectFirst: (error: Error) => void = () => {};
      sdkMock.setCloudMlModelChoice
        .mockImplementationOnce(
          () => new Promise<CloudMlModelChoicesResponseDto>((_resolve, reject) => (rejectFirst = reject)),
        )
        .mockResolvedValueOnce({ choices: [choice(CloudMlModelGroup.Descriptions, 'ms_DESCHUGE')] });
      render(WorkloadRoutingTable);

      const group = await findPicker('descriptions & tags');
      await fireEvent.click(within(group).getByRole('radio', { name: /Descriptions · Best/ }));
      await vi.waitFor(() => expect(sdkMock.setCloudMlModelChoice).toHaveBeenCalledTimes(1));
      await fireEvent.click(within(group).getByRole('radio', { name: /Descriptions · Huge/ }));
      rejectFirst(new Error('offline'));

      await vi.waitFor(() => expect(sdkMock.setCloudMlModelChoice).toHaveBeenCalledTimes(2));
      expect(sdkMock.setCloudMlModelChoice).toHaveBeenLastCalledWith({
        group: CloudMlModelGroup.Descriptions,
        cloudMlModelChoiceUpdateDto: { modelId: 'ms_DESCHUGE' },
      });
      expect(handleError).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => expect(within(group).getByRole('radio', { name: /Descriptions · Huge/ })).toBeChecked());
    });

    it('offers the chosen cloud model for a Both workload whatever its route, restoration per mode', async () => {
      // No route points at Frameleaf Cloud: a job the person sends there still uses these choices.
      useDraft(true, { restoration: 'both' });
      useCloudModels([choice(CloudMlModelGroup.RestorationFaithful, 'ms_RESTFAIT')]);
      render(WorkloadRoutingTable);

      const faithful = await findPicker('restoration (faithful)');
      const creative = await findPicker('restoration (creative)');
      expect(radioValues(cloudStops(faithful, 'Restoration (faithful)'))).toEqual(['ms_RESTFAIT']);
      expect(radioValues(cloudStops(creative, 'Restoration (creative)'))).toEqual(['ms_RESTCREA']);
      expect(within(faithful).getByRole('radio')).toBeChecked();
      // the faithful recommendation never stands in for creative work: the picker asks for a choice
      expect(within(creative).getByRole('radio')).not.toBeChecked();
      expect(
        within(creative).getByText(
          'Frameleaf Cloud recommends no model for this work in this region. Choose one; these jobs are refused until you do.',
        ),
      ).toBeInTheDocument();
      // restoration workers bring their own models, so there is no local model to choose here
      expect(
        within(faithful).getByText(/This server's model for this work comes with the worker that runs it/),
      ).toBeInTheDocument();
      expect(sdkMock.getMlWorkloadRoutes).not.toHaveBeenCalled();
    });

    it('gives Studio AI a speech to text and a speech model, and always asks for them', async () => {
      useDraft(true, { studio: 'cloud' });
      useCloudModels([choice(CloudMlModelGroup.Tts, 'ms_STUDIOVO')]);
      render(WorkloadRoutingTable);

      const words = await findPicker('speech to text and captions');
      const voice = await findPicker('speech');
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
      expect(await findPicker('descriptions & tags')).toBeInTheDocument();
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
      expect(screen.queryByRole('radiogroup', { name: /Frameleaf Cloud model for/ })).toBeNull();
    });
  });

  describe("This server's model on the same slider (FL-189)", () => {
    it('picks the local description model on white and green stops, saved with the settings bar', async () => {
      const store = useDraft(false, {}, 'Qwen/Qwen2.5-VL-3B-Instruct');
      sdkMock.getCloudMlStatus.mockResolvedValue(status(CloudMlConnection.NotLinked));
      sdkMock.getHardwareCheck.mockResolvedValue(hardwareCheck({}));
      render(WorkloadRoutingTable);

      const picker = await findPicker('descriptions & tags');
      await vi.waitFor(() =>
        expect(within(picker).getByText('Green · your GPU (NVIDIA GeForce RTX 3060, 12 GB)')).toBeInTheDocument(),
      );
      const local = localStopsOf(picker);
      // the names the description setting accepts, lightest first; nothing from the cloud with cloud off
      expect(radioValues(local)).toEqual(LOCAL_MODELS);
      expect(within(picker).queryByRole('radiogroup', { name: /Frameleaf Cloud model for/ })).toBeNull();
      expect(within(local).getByRole('radio', { name: /^Qwen2\.5-VL 3B: Your GPU · about 6 GB/ })).toBeChecked();
      expect(within(picker).getByText('White · processor, no GPU')).toBeInTheDocument();
      // a model that needs more memory than the GPU has is crossed out, with the reason
      expect(within(local).getByRole('radio', { name: /^Qwen2\.5-VL 32B/ })).toBeDisabled();
      expect(
        within(picker).getByText('Qwen2.5-VL 32B needs about 64 GB of GPU memory; NVIDIA GeForce RTX 3060 has 12 GB.'),
      ).toBeInTheDocument();
      expect(within(picker).getByText(/downloads the first time a job uses it/)).toBeInTheDocument();

      await fireEvent.click(within(local).getByRole('radio', { name: /^Qwen2\.5-VL 7B: CPU · slow/ }));
      expect(store.draft.machineLearning.imageDescription?.modelName).toBe('Qwen/Qwen2.5-VL-7B-Instruct');
      expect(store.baseline.machineLearning.imageDescription?.modelName).toBe('Qwen/Qwen2.5-VL-3B-Instruct');
      expect(within(local).getByRole('radio', { name: /^Qwen2\.5-VL 7B/ })).toBeChecked();
      expect(
        within(picker).getByText(/Save with the settings bar to use Qwen2\.5-VL 7B on this server\./),
      ).toBeInTheDocument();
      // a local model is a setting, not a Frameleaf Cloud choice
      expect(sdkMock.setCloudMlModelChoice).not.toHaveBeenCalled();
    });

    it("keeps each side's model when the other side changes", async () => {
      const store = useDraft(true, { descriptions: 'both' }, 'Qwen/Qwen2.5-VL-3B-Instruct');
      useCloudModels();
      sdkMock.getHardwareCheck.mockResolvedValue(hardwareCheck({}));
      sdkMock.setCloudMlModelChoice.mockResolvedValue({
        choices: [choice(CloudMlModelGroup.Descriptions, 'ms_DESCHUGE')],
      });
      render(WorkloadRoutingTable);

      const picker = await findPicker('descriptions & tags');
      const cloud = await vi.waitFor(() => cloudStops(picker, 'Descriptions & tags'));
      const local = localStopsOf(picker);
      // one track: this server's stops, then Frameleaf Cloud's; each side is a real radio group, sized by stop count
      expect(radioValues(picker)).toEqual([...LOCAL_MODELS, 'ms_DESCFAST', 'ms_DESCBEST', 'ms_DESCHUGE']);
      expect(local.parentElement).toBe(cloud.parentElement);
      expect(local.nextElementSibling).toBe(cloud);
      expect(local.style.getPropertyValue('--ms-count')).toBe(String(LOCAL_MODELS.length));
      expect(cloud.style.getPropertyValue('--ms-count')).toBe('3');
      expect(within(picker).getByText('Blue · Frameleaf Cloud only, cost shown first')).toBeInTheDocument();

      await fireEvent.click(within(cloud).getByRole('radio', { name: /Descriptions · Huge/ }));
      await vi.waitFor(() =>
        expect(sdkMock.setCloudMlModelChoice).toHaveBeenCalledWith({
          group: CloudMlModelGroup.Descriptions,
          cloudMlModelChoiceUpdateDto: { modelId: 'ms_DESCHUGE' },
        }),
      );
      expect(store.draft.machineLearning.imageDescription?.modelName).toBe('Qwen/Qwen2.5-VL-3B-Instruct');
      expect(within(local).getByRole('radio', { name: /^Qwen2\.5-VL 3B/ })).toBeChecked();

      await fireEvent.click(within(local).getByRole('radio', { name: /^Florence-2 large/ }));
      expect(store.draft.machineLearning.imageDescription?.modelName).toBe('microsoft/Florence-2-large-ft');
      expect(within(cloud).getByRole('radio', { name: /Descriptions · Huge/ })).toBeChecked();
      expect(sdkMock.setCloudMlModelChoice).toHaveBeenCalledTimes(1);
      expect(store.draft.frameleafCloud!.cloudMl.routing.descriptions).toBe('both');
    });

    it('shows every local stop as white before a hardware check', async () => {
      useDraft(false, {}, 'Qwen/Qwen2.5-VL-3B-Instruct');
      sdkMock.getCloudMlStatus.mockResolvedValue(status(CloudMlConnection.NotLinked));
      render(WorkloadRoutingTable);

      const picker = await findPicker('descriptions & tags');
      const local = localStopsOf(picker);
      for (const radio of within(local).getAllByRole('radio')) {
        expect(radio).toBeEnabled();
      }
      expect(within(picker).getByText('White · processor, no GPU')).toBeInTheDocument();
      expect(within(picker).queryByText(/^Green/)).toBeNull();
      expect(within(picker).getByText(/^No hardware check yet, so every model shows as white\./)).toBeInTheDocument();
    });

    it('crosses out the side a route does not use, with the reason', async () => {
      useDraft(true, { descriptions: 'cloud', upscale: 'local' }, 'Qwen/Qwen2.5-VL-3B-Instruct');
      useCloudModels();
      sdkMock.getHardwareCheck.mockResolvedValue(hardwareCheck({}));
      render(WorkloadRoutingTable);

      const picker = await findPicker('descriptions & tags');
      await vi.waitFor(() => cloudStops(picker, 'Descriptions & tags'));
      for (const radio of within(localStopsOf(picker)).getAllByRole('radio')) {
        expect(radio).toBeDisabled();
      }
      expect(
        within(picker).getByText(/^This work is set to Cloud only, so its jobs don't use this server's model\./),
      ).toBeInTheDocument();
      expect(
        within(cloudStops(picker, 'Descriptions & tags')).getByRole('radio', { name: /Descriptions · Best/ }),
      ).toBeEnabled();
    });

    it('crosses out the blue stops of work set to Local only', async () => {
      useDraft(true, { descriptions: 'local' }, 'Qwen/Qwen2.5-VL-3B-Instruct');
      useCloudModels([choice(CloudMlModelGroup.Descriptions, 'ms_DESCBEST')]);
      render(WorkloadRoutingTable);

      const picker = await findPicker('descriptions & tags');
      const cloud = await vi.waitFor(() => cloudStops(picker, 'Descriptions & tags'));
      for (const radio of within(cloud).getAllByRole('radio')) {
        expect(radio).toBeDisabled();
      }
      expect(
        within(picker).getByText(
          'This work is set to run on this server only. Choose Both or Cloud only in Where each job runs.',
        ),
      ).toBeInTheDocument();
      expect(within(picker).queryByRole('button', { name: /Use the recommended model/ })).toBeNull();
      expect(within(localStopsOf(picker)).getByRole('radio', { name: /^Qwen2\.5-VL 7B/ })).toBeEnabled();
    });

    it('says which model this server uses when it was typed in Machine learning settings', async () => {
      useDraft(false, {}, 'my-org/custom-vlm');
      sdkMock.getCloudMlStatus.mockResolvedValue(status(CloudMlConnection.NotLinked));
      render(WorkloadRoutingTable);

      const picker = await findPicker('descriptions & tags');
      expect(
        within(picker).getByText('This server uses my-org/custom-vlm, set in Machine learning settings.'),
      ).toBeInTheDocument();
      for (const radio of within(localStopsOf(picker)).getAllByRole('radio')) {
        expect(radio).not.toBeChecked();
      }
    });
  });
});
