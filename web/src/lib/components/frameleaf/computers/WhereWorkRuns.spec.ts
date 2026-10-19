import {
  CloudMlConnection,
  CloudRouteMode,
  MediaOperationKind,
  MlDestinationKind,
  MlWorkload,
  MlWorkerReadiness,
  StartWith,
  WorkerInventorySource,
} from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import en from '../../../../../../i18n/en.json';
import WhereWorkRuns from './WhereWorkRuns.svelte';

const draft = vi.hoisted(() => ({
  store: undefined as unknown,
}));
vi.mock('$lib/frameleaf/system-config-draft.svelte', () => ({ getSystemConfigDraft: () => draft.store }));
vi.mock('$lib/managers/feature-flags-manager.svelte', () => ({
  featureFlagsManager: { value: { configFile: false } },
}));

const LIBRARY = [MlWorkload.Face, MlWorkload.Clip, MlWorkload.Ocr, MlWorkload.Enrichment, MlWorkload.PetRecognition];
const server = { id: 'srv', name: 'This server', kind: MlDestinationKind.Local, enabled: true, workloads: LIBRARY };
const office = {
  id: 'office',
  name: 'Office PC',
  kind: MlDestinationKind.Lan,
  enabled: true,
  workloads: [MlWorkload.Enrichment, MlWorkload.Upscale],
};
const routes = (values: Record<string, string | null>) => ({
  routes: Object.entries(values).map(([workload, destinationId]) => ({ workload, destinationId })),
});
const HOME = {
  [MlWorkload.Face]: 'srv',
  [MlWorkload.Clip]: 'srv',
  [MlWorkload.Ocr]: 'srv',
  [MlWorkload.Enrichment]: 'srv',
  [MlWorkload.PetRecognition]: 'srv',
};
const entry = (overrides: object) => ({
  id: 'srv',
  name: 'This server',
  kind: 'local',
  source: WorkerInventorySource.MlDestination,
  enabled: true,
  readiness: MlWorkerReadiness.Cpu,
  gpus: [],
  routedWorkloads: [],
  renderKinds: [],
  ...overrides,
});
const cloudMl = (routing = {}) => ({
  enabled: true,
  startWith: StartWith.Local,
  routing: {
    descriptions: CloudRouteMode.Local,
    upscale: CloudRouteMode.Local,
    restoration: CloudRouteMode.Local,
    studio: CloudRouteMode.Local,
    interpolation: CloudRouteMode.Local,
    ...routing,
  },
});

/** One row of the table: its text, and its picker when it has one. */
const row = (name: string) =>
  screen.getByText(name, { selector: '.kit-row strong' }).closest('.kit-row') as HTMLElement;

describe('Where work runs (FL-364)', () => {
  beforeAll(() => {
    addMessages('dev', en);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    draft.store = undefined;
    sdkMock.listMlDestinations.mockResolvedValue([server] as never);
    sdkMock.getMlWorkloadRoutes.mockResolvedValue(routes(HOME) as never);
    sdkMock.getWorkerInventory.mockResolvedValue({ entries: [entry({})], machineLearningEnabled: true } as never);
    sdkMock.getRenderWorkerCompatibility.mockResolvedValue({ qualified: [], unavailable: [] });
    sdkMock.getHardwareCheck.mockResolvedValue({
      ml: { reachable: true, backend: 'CPU', model: null, vramGb: null },
      server: { reachable: true, backend: 'CPU', model: null, vramGb: null },
    } as never);
    sdkMock.getCloudMlStatus.mockResolvedValue({ connection: CloudMlConnection.NotLinked } as never);
  });

  it('opens on the answer for a server on its own, with no picker that has only one answer', async () => {
    render(WhereWorkRuns);

    expect(await screen.findByRole('heading', { name: 'Everything runs on this server' })).toBeInTheDocument();
    expect(screen.getByText(/Studio exports can’t run yet/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Add a computer' })).toBeInTheDocument();
    expect(screen.queryAllByRole('combobox')).toHaveLength(0);
    // One table, nine rows, in the household names.
    expect(within(row('Faces & identity')).getByText('This server')).toBeInTheDocument();
    expect(row('Faces & identity')).toHaveTextContent(
      'Works here. Runs at home unless face recognition is turned on for Frameleaf Cloud.',
    );
    expect(within(row('Enhance & upscale')).getByText('Can’t run yet')).toBeInTheDocument();
    expect(row('Studio export')).toHaveTextContent('Exports are never made on Frameleaf Cloud.');
    expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument();
    for (const old of ['Smart search', 'Frame interpolation', 'Studio renders', 'Local only']) {
      expect(screen.queryByText(old)).not.toBeInTheDocument();
    }
  });

  it('says Studio export runs on the connected computer, as the other pages do', async () => {
    sdkMock.getRenderWorkerCompatibility.mockResolvedValue({
      qualified: [MediaOperationKind.StudioExport],
      unavailable: [],
    });
    sdkMock.getWorkerInventory.mockResolvedValue({
      entries: [
        entry({}),
        entry({
          id: 'r1',
          name: 'Office PC',
          kind: 'lan',
          source: WorkerInventorySource.RenderWorker,
          readiness: 'model-ready',
        }),
      ],
      machineLearningEnabled: true,
    } as never);
    render(WhereWorkRuns);

    await screen.findByRole('heading', { name: /share the work|Everything runs on this server/ });
    expect(within(row('Studio export')).getByText('Office PC')).toBeInTheDocument();
  });

  it('moves a row with one Save, saying what will change first', async () => {
    sdkMock.listMlDestinations.mockResolvedValue([server, office] as never);
    sdkMock.getWorkerInventory.mockResolvedValue({
      entries: [entry({}), entry({ id: 'office', name: 'Office PC', kind: 'lan', readiness: 'model-ready' })],
      machineLearningEnabled: true,
    } as never);
    sdkMock.setMlWorkloadRoute.mockResolvedValue(routes({ ...HOME, [MlWorkload.Enrichment]: 'office' }) as never);
    render(WhereWorkRuns);

    const picker = await screen.findByRole('combobox', { name: 'Where Descriptions & tags runs' });
    expect(picker).toHaveValue('srv');
    expect(
      within(picker)
        .getAllByRole('option')
        .map((option) => option.textContent?.trim()),
    ).toEqual(['This server', 'Office PC', 'Nowhere (keep this off)']);
    const save = screen.getByRole('button', { name: 'Save changes' });
    expect(save).toBeDisabled();

    await fireEvent.change(picker, { target: { value: 'office' } });
    expect(screen.getByText('1 change not saved yet')).toBeInTheDocument();
    expect(screen.getByText('Descriptions & tags moves to Office PC.')).toBeInTheDocument();
    expect(sdkMock.setMlWorkloadRoute).not.toHaveBeenCalled();

    await fireEvent.click(save);
    await waitFor(() =>
      expect(sdkMock.setMlWorkloadRoute).toHaveBeenCalledWith({
        workload: MlWorkload.Enrichment,
        mlWorkloadRouteUpdateDto: { destinationId: 'office' },
      }),
    );
    expect(await screen.findByText(/^Saved\. New work follows these choices\./)).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Where Descriptions & tags runs' })).toHaveValue('office');
  });

  it('shows the cloud record as Ask me each time and saves a change to both records together', async () => {
    const saved = cloudMl({ descriptions: CloudRouteMode.Both });
    const store = {
      baseline: { frameleafCloud: { cloudMl: saved } },
      draft: { frameleafCloud: { cloudMl: structuredClone(saved) } },
      saveKeys: vi.fn().mockResolvedValue(true),
    };
    draft.store = store;
    sdkMock.getCloudMlStatus.mockResolvedValue({ connection: CloudMlConnection.Ready } as never);
    sdkMock.setMlWorkloadRoute.mockResolvedValue(routes({ ...HOME, [MlWorkload.Enrichment]: null }) as never);
    render(WhereWorkRuns);

    const picker = await screen.findByRole('combobox', { name: 'Where Descriptions & tags runs' });
    expect(picker).toHaveValue('ask');
    expect(row('Descriptions & tags')).toHaveTextContent('You choose each time you start one.');
    // Faces has no Frameleaf Cloud choice in this table; it reaches the cloud only through its destination route (FL-455).
    expect(screen.queryByRole('combobox', { name: 'Where Faces & identity runs' })).not.toBeInTheDocument();

    await fireEvent.change(picker, { target: { value: 'none' } });
    expect(screen.getByText('Descriptions & tags turns off.')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(store.saveKeys).toHaveBeenCalledWith(['frameleafCloud']));
    expect(sdkMock.setMlWorkloadRoute).toHaveBeenCalledWith({
      workload: MlWorkload.Enrichment,
      mlWorkloadRouteUpdateDto: { destinationId: null },
    });
    expect(store.draft.frameleafCloud.cloudMl.routing.descriptions).toBe(CloudRouteMode.Local);
  });

  it('offers search one place, Frameleaf Cloud included, never Ask, and agrees with its destination route', async () => {
    const fc = {
      id: 'fc',
      name: 'Frameleaf Cloud',
      kind: MlDestinationKind.FrameleafCloud,
      enabled: true,
      workloads: [MlWorkload.Clip],
      consent: { required: true, acknowledgedAt: '2026-10-01T00:00:00Z', version: '1', requiredVersion: '1' },
    };
    const saved = cloudMl();
    const store = {
      baseline: { frameleafCloud: { cloudMl: saved } },
      draft: { frameleafCloud: { cloudMl: structuredClone(saved) } },
      saveKeys: vi.fn().mockResolvedValue(true),
    };
    draft.store = store;
    sdkMock.listMlDestinations.mockResolvedValue([server, fc] as never);
    sdkMock.getMlWorkloadRoutes.mockResolvedValue(routes({ ...HOME, [MlWorkload.Clip]: 'fc' }) as never);
    sdkMock.getCloudMlStatus.mockResolvedValue({ connection: CloudMlConnection.Ready } as never);
    sdkMock.setMlWorkloadRoute.mockResolvedValue(routes(HOME) as never);
    render(WhereWorkRuns);

    const name = en.frameleaf_workruns_name_search;
    const picker = await screen.findByRole('combobox', { name: `Where ${name} runs` });
    expect(picker).toHaveValue('cloud');
    expect([...(picker as HTMLSelectElement).options].map((option) => option.value)).toEqual(['srv', 'cloud', 'none']);
    expect(row(name)).toHaveTextContent('Runs in one place only, so results never mix two models.');

    await fireEvent.change(picker, { target: { value: 'srv' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(sdkMock.setMlWorkloadRoute).toHaveBeenCalledWith({
        workload: MlWorkload.Clip,
        mlWorkloadRouteUpdateDto: { destinationId: 'srv' },
      }),
    );
    // Search has no cloud routing mode to save.
    expect(store.saveKeys).not.toHaveBeenCalled();
  });

  it('says a helper is not answering, and that its work waits', async () => {
    sdkMock.listMlDestinations.mockResolvedValue([server, office] as never);
    sdkMock.getMlWorkloadRoutes.mockResolvedValue(routes({ ...HOME, [MlWorkload.Enrichment]: 'office' }) as never);
    sdkMock.getWorkerInventory.mockResolvedValue({
      entries: [
        entry({}),
        entry({ id: 'office', name: 'Office PC', kind: 'lan', readiness: MlWorkerReadiness.Unreachable }),
      ],
      machineLearningEnabled: true,
    } as never);
    render(WhereWorkRuns);

    expect(await screen.findByRole('heading', { name: 'Office PC isn’t answering' })).toBeInTheDocument();
    expect(screen.getByText(/Descriptions & tags waits until it’s back\./)).toBeInTheDocument();
    expect(within(row('Descriptions & tags')).getByText('Waiting')).toBeInTheDocument();
    expect(row('Descriptions & tags')).toHaveTextContent('Waits until Office PC answers. Nothing moves on its own.');
    expect(
      within(row('Descriptions & tags')).getByRole('option', { name: 'Office PC (not answering)' }),
    ).toBeInTheDocument();
  });
});
