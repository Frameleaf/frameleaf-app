import {
  CloudMlConnection,
  CloudRouteMode,
  MediaOperationKind,
  MlDestinationKind,
  MlWhenUnavailable,
  MlProcessingSource,
  MlProcessingSourceState,
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
import { WorkRunsDraft } from './work-runs-draft.svelte';

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

/** One row: a who-does-what row (approved design, 2026-11-04) or a kit row (the order to try). */
const row = (name: string) =>
  screen.getByText(name, { selector: '.kit-row strong, .work-name strong' }).closest('.kit-row, .work') as HTMLElement;
/** A row's choices, one button for each place, lined up as columns. */
const choices = (name: string) => screen.findByRole('radiogroup', { name: `Where ${name} runs` });
const enabled = (group: HTMLElement) =>
  within(group)
    .getAllByRole('radio')
    .filter((radio) => !(radio as HTMLButtonElement).disabled)
    .map((radio) => radio.textContent?.trim());
const checked = (group: HTMLElement) =>
  within(group)
    .getAllByRole('radio')
    .find((radio) => radio.getAttribute('aria-checked') === 'true')
    ?.textContent?.trim();

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

  it('opens on the answer for a server on its own, still with the chooser and Frameleaf Cloud shown', async () => {
    render(WhereWorkRuns);

    expect(await screen.findByRole('heading', { name: 'Everything runs on this server' })).toBeInTheDocument();
    expect(screen.getByText(/Studio exports can’t run yet/)).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Add a computer' }).length).toBeGreaterThan(0);
    // The chooser stays with one place, so this server versus Frameleaf Cloud is always visible.
    const faces = await choices('Faces & identity');
    expect(checked(faces)).toBe('This server');
    expect(within(faces).getByRole('radio', { name: 'Frameleaf Cloud' })).toBeDisabled();
    expect(within(faces).getByRole('radio', { name: 'Frameleaf Cloud' })).toHaveAttribute(
      'title',
      'Set up Frameleaf Cloud to send this work there.',
    );
    expect(row('Faces & identity')).toHaveTextContent(
      'Works here. Runs at home unless face recognition is turned on for Frameleaf Cloud.',
    );
    // Work that nothing here can do offers to add a computer, as the approved grid does.
    expect(within(row('Enhance & upscale')).getByRole('link', { name: 'Add a computer' })).toBeInTheDocument();
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

    const picker = await choices('Descriptions & tags');
    expect(checked(picker)).toBe('This server');
    expect(enabled(picker)).toEqual(['This server', 'Office PC', 'Nowhere']);
    // The save bar appears only once something has changed.
    expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument();

    await fireEvent.click(within(picker).getByRole('radio', { name: 'Office PC' }));
    expect(screen.getByText('1 change not saved yet')).toBeInTheDocument();
    expect(screen.getByText('Descriptions & tags moves to Office PC.')).toBeInTheDocument();
    expect(sdkMock.setMlWorkloadRoute).not.toHaveBeenCalled();

    await fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(sdkMock.setMlWorkloadRoute).toHaveBeenCalledWith({
        workload: MlWorkload.Enrichment,
        mlWorkloadRouteUpdateDto: { destinationId: 'office' },
      }),
    );
    expect(await screen.findByText(/^Saved\. New work follows these choices\./)).toBeInTheDocument();
    expect(checked(await choices('Descriptions & tags'))).toBe('Office PC');
  });

  it('keeps unsaved choices in the page’s draft when the table is drawn again (FL-1252)', async () => {
    sdkMock.listMlDestinations.mockResolvedValue([server, office] as never);
    sdkMock.getWorkerInventory.mockResolvedValue({
      entries: [entry({}), entry({ id: 'office', name: 'Office PC', kind: 'lan', readiness: 'model-ready' })],
      machineLearningEnabled: true,
    } as never);
    const kept = new WorkRunsDraft();
    const first = render(WhereWorkRuns, { part: 'everyday', draft: kept });
    await fireEvent.click(within(await choices('Descriptions & tags')).getByRole('radio', { name: 'Office PC' }));
    expect(screen.getByText('1 change not saved yet')).toBeInTheDocument();
    first.unmount();

    render(WhereWorkRuns, { part: 'everyday', draft: kept });
    expect(checked(await choices('Descriptions & tags'))).toBe('Office PC');
    expect(screen.getByText('1 change not saved yet')).toBeInTheDocument();
  });

  it('drops a kept pick for a computer that is no longer there', async () => {
    const kept = new WorkRunsDraft();
    kept.picked = { descriptions: 'gone-pc' } as WorkRunsDraft['picked'];
    render(WhereWorkRuns, { part: 'everyday', draft: kept });

    expect(checked(await choices('Descriptions & tags'))).toBe('This server');
    expect(screen.queryByText('1 change not saved yet')).not.toBeInTheDocument();
  });

  it('opens the page’s own Add a computer instead of following the link to it (FL-1245)', async () => {
    const onAdd = vi.fn();
    render(WhereWorkRuns, { part: 'everyday', onAdd });

    await choices('Faces & identity');
    const link = within(row('Enhance & upscale')).getByRole('link', { name: 'Add a computer' });
    const followed = await fireEvent.click(link);
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(followed).toBe(false);
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

    const picker = await choices('Descriptions & tags');
    expect(checked(picker)).toBe('Ask each time');
    expect(row('Descriptions & tags')).toHaveTextContent('You choose each time you start one.');
    // Faces has no Frameleaf Cloud choice in this table; it reaches the cloud only through its destination route (FL-455).
    expect(within(await choices('Faces & identity')).getByRole('radio', { name: 'Frameleaf Cloud' })).toBeDisabled();

    await fireEvent.click(within(picker).getByRole('radio', { name: 'Nowhere' }));
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
    const picker = await choices(name);
    expect(checked(picker)).toBe('Frameleaf Cloud');
    // Never Ask: a column another row offers is shown here switched off.
    expect(enabled(picker)).toEqual(['This server', 'Frameleaf Cloud', 'Nowhere']);
    expect(row(name)).toHaveTextContent('Runs in one place only, so results never mix two models.');

    await fireEvent.click(within(picker).getByRole('radio', { name: 'This server' }));
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
    expect(row('Descriptions & tags')).toHaveTextContent('Waiting: Office PC isn’t answering.');
    expect(row('Descriptions & tags')).toHaveTextContent('Waits until Office PC answers. Nothing moves on its own.');
    expect(checked(await choices('Descriptions & tags'))).toBe('Office PC');
  });

  describe('the order to try (FL-456)', () => {
    const sources = [
      { source: MlProcessingSource.Local, state: MlProcessingSourceState.Ready, ready: 1, total: 1 },
      { source: MlProcessingSource.Desktops, state: MlProcessingSourceState.NotAnswering, ready: 0, total: 2 },
      { source: MlProcessingSource.Cloud, state: MlProcessingSourceState.NeedsPermission, ready: 0, total: 1 },
    ];
    const order = [MlProcessingSource.Local, MlProcessingSource.Desktops, MlProcessingSource.Cloud];

    beforeEach(() => {
      sdkMock.getMlProcessingOrder.mockResolvedValue({
        order,
        workloads: [],
        sources,
        whenUnavailable: MlWhenUnavailable.Wait,
      });
      sdkMock.setMlProcessingOrder.mockImplementation(({ mlProcessingOrderUpdateDto }) =>
        Promise.resolve({
          order: mlProcessingOrderUpdateDto.order,
          workloads: [],
          sources,
          whenUnavailable: mlProcessingOrderUpdateDto.whenUnavailable ?? MlWhenUnavailable.Wait,
        }),
      );
      sdkMock.getMlWorkloadRoutes.mockResolvedValue({
        routes: Object.entries(HOME).map(([workload, destinationId]) => ({
          workload,
          destinationId,
          followsOrder: true,
        })),
      } as never);
    });

    it('lists each place in order with what it can do now', async () => {
      render(WhereWorkRuns);

      expect(await screen.findByRole('heading', { name: 'Order to try' })).toBeInTheDocument();
      expect(row('1. This server')).toHaveTextContent('Ready');
      expect(row('2. Your computers')).toHaveTextContent('Not answering');
      expect(row('2. Your computers')).toHaveTextContent('0 of 2 ready');
      expect(row('3. Frameleaf Cloud')).toHaveTextContent('Needs your permission');
      expect(screen.getByRole('button', { name: 'Move This server up' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Move Frameleaf Cloud down' })).toBeDisabled();
      // rows that follow the order say so
      // A row with only one place still shows its chooser, set to the order.
      expect(checked(await choices('Faces & identity'))).toBe('In order');
    });

    it('saves a new order with the rest of the page', async () => {
      render(WhereWorkRuns);

      await fireEvent.click(await screen.findByRole('button', { name: 'Move Frameleaf Cloud up' }));
      expect(row('2. Frameleaf Cloud')).toBeInTheDocument();
      expect(
        screen.getByText('New work will try This server, Frameleaf Cloud, and Your computers, in that order.'),
      ).toBeInTheDocument();

      await fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
      await waitFor(() =>
        expect(sdkMock.setMlProcessingOrder).toHaveBeenCalledWith({
          mlProcessingOrderUpdateDto: {
            order: [MlProcessingSource.Local, MlProcessingSource.Cloud, MlProcessingSource.Desktops],
          },
        }),
      );
      expect(sdkMock.setMlWorkloadRoute).not.toHaveBeenCalled();
    });

    it('saves what happens while a computer at home is not answering', async () => {
      sdkMock.listMlDestinations.mockResolvedValue([server, office] as never);
      sdkMock.getMlProcessingOrder.mockResolvedValue({
        order,
        workloads: [],
        sources,
        whenUnavailable: MlWhenUnavailable.Wait,
      });
      sdkMock.getWorkerInventory.mockResolvedValue({
        entries: [entry({}), entry({ id: 'office', name: 'Office PC', kind: 'lan' })],
        machineLearningEnabled: true,
      } as never);
      render(WhereWorkRuns, { part: 'everyday' });

      const group = await screen.findByRole('group', { name: 'When a computer at home isn’t answering' });
      expect(screen.getByText(/Waits, and starts when the computer is back/)).toBeInTheDocument();
      await fireEvent.click(within(group).getByRole('button', { name: 'Stop and tell me' }));
      await fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
      await waitFor(() =>
        expect(sdkMock.setMlProcessingOrder).toHaveBeenCalledWith({
          mlProcessingOrderUpdateDto: { order, whenUnavailable: MlWhenUnavailable.Stop },
        }),
      );
    });
  });
});
