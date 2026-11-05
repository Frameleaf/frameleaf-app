import { MediaOperationKind, MlWorkerReadiness, WorkerInventorySource } from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import en from '../../../../../../i18n/en.json';
import ComputersSection from './ComputersSection.svelte';
import type { ComputersData } from './loaders';

const panels = vi.hoisted(() => ({ addRequest: 0, enrolRequest: 0, showRoutes: true as boolean | undefined }));
vi.mock('$app/state', () => ({ page: { url: new URL('https://example.test/user-settings?area=processing') } }));
// The managers under Details are covered by their own specs; here they only record what they are asked.
vi.mock('$lib/components/frameleaf/MlDestinationsPanel.svelte', async () => ({
  default: (await import('../../../../test-data/components/MockText.svelte')).default,
}));
vi.mock('$lib/components/frameleaf/WorkerInventoryPanel.svelte', async () => ({
  default: (await import('../../../../test-data/components/MockText.svelte')).default,
}));
vi.mock('./RenderWorkersSection.svelte', async () => ({
  default: (await import('../../../../test-data/components/MockText.svelte')).default,
}));
// Who does what has its own spec (WhereWorkRuns.spec.ts).
vi.mock('$lib/components/frameleaf/computers/WhereWorkRuns.svelte', async () => ({
  default: (await import('../../../../test-data/components/MockText.svelte')).default,
}));

const entry = (overrides: object) => ({
  id: 'srv',
  name: 'This server',
  kind: 'local',
  source: WorkerInventorySource.MlDestination,
  enabled: true,
  readiness: MlWorkerReadiness.Cpu,
  gpus: [],
  routedWorkloads: ['face', 'clip'],
  renderKinds: [],
  ...overrides,
});
const data = (entries: object[], machineLearningEnabled = true) =>
  ({
    processing: { destinations: [], routes: [], inventory: { entries, machineLearningEnabled } },
    render: { workers: [], limits: { instance: {}, users: [] }, audit: [], users: [] },
  }) as unknown as ComputersData;

/** One of the approved computer cards (2026-11-04). */
const computer = (name: string) =>
  screen.getByText(name, { selector: '.computer-name strong' }).closest('li') as HTMLElement;

describe('Computers (FL-364)', () => {
  beforeAll(() => {
    addMessages('dev', en);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    panels.addRequest = 0;
    sdkMock.getRenderWorkerCompatibility.mockResolvedValue({ qualified: [], unavailable: [] });
  });

  it('says this server does all the work when nothing else helps, and offers to add a computer', async () => {
    render(ComputersSection, { data: data([entry({})]) });

    expect(within(computer('This server')).getByText('Ready')).toBeInTheDocument();
    expect(within(computer('This server')).getByText('Built in')).toBeInTheDocument();
    expect(within(computer('This server')).getByText('2 kinds of work')).toBeInTheDocument();
    expect(within(computer('This server')).getByRole('link', { name: /Graphics card check/ })).toHaveAttribute(
      'href',
      expect.stringContaining('section=hardware'),
    );
    // With only this server, Frameleaf Cloud is the other way to go faster.
    expect(within(computer('Frameleaf Cloud')).getByText('Not set up')).toBeInTheDocument();
    const add = await screen.findByRole('button', { name: /^Add a computer/ });
    expect(add).toHaveAttribute('aria-expanded', 'false');
    await fireEvent.click(add);
    expect(screen.getByRole('region', { name: 'Add a computer' })).toBeInTheDocument();
  });

  it('lists a helper once, however many records the server keeps for it, with one status', async () => {
    sdkMock.getRenderWorkerCompatibility.mockResolvedValue({
      qualified: [MediaOperationKind.StudioExport],
      unavailable: [],
    });
    render(ComputersSection, {
      data: data([
        entry({}),
        entry({ id: 'o1', name: 'Office PC', kind: 'lan', readiness: 'model-ready', routedWorkloads: ['enrichment'] }),
        entry({
          id: 'o2',
          name: 'Office PC',
          kind: 'lan',
          source: WorkerInventorySource.RenderWorker,
          readiness: 'model-ready',
          routedWorkloads: [],
          renderKinds: ['studio_export', 'restoration'],
          gpus: [{ name: 'GeForce RTX 3060', memoryTotalBytes: 1 }],
        }),
      ]),
    });

    expect(screen.getAllByText('Office PC', { selector: '.computer-name strong' })).toHaveLength(1);
    const office = within(computer('Office PC'));
    expect(office.getByText('At home · GeForce RTX 3060')).toBeInTheDocument();
    expect(office.getByText('Ready')).toBeInTheDocument();
    expect(office.getByText('3 kinds of work')).toBeInTheDocument();
    // What it helps with is in Advanced, beside its Manage.
    await fireEvent.click(screen.getByRole('button', { name: 'Advanced' }));
    expect(await screen.findByText(/AI features and Studio and restoration/)).toBeInTheDocument();
  });

  it('says plainly when a helper is not answering', () => {
    render(ComputersSection, {
      data: data([
        entry({}),
        entry({ id: 'o1', name: 'Office PC', kind: 'lan', readiness: MlWorkerReadiness.Unreachable }),
      ]),
    });

    expect(screen.getByText('Office PC isn’t answering')).toBeInTheDocument();
    const office = within(computer('Office PC'));
    expect(office.getByText('Not answering')).toBeInTheDocument();
    expect(office.getByText('Work set to run there waits until it’s back.')).toBeInTheDocument();
  });

  it('says AI features are off and links to the switch, instead of naming a place', () => {
    render(ComputersSection, { data: data([entry({ readiness: MlWorkerReadiness.Unknown })], false) });

    expect(screen.getByText('AI features are turned off')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Turn on AI features' })).toHaveAttribute(
      'href',
      expect.stringContaining('area=intelligence'),
    );
    expect(within(computer('This server')).getByText('Ready · AI features off')).toBeInTheDocument();
  });

  it('offers the two ways a computer can be connected today, and no code that cannot work', async () => {
    render(ComputersSection, { data: data([entry({})]) });

    await fireEvent.click(screen.getByRole('button', { name: /^Add a computer/ }));
    const add = within(screen.getByRole('region', { name: 'Add a computer' }));
    expect(add.getByText(/Frameleaf helper for Mac and Windows is not available yet/)).toBeInTheDocument();
    expect(add.queryByRole('textbox')).not.toBeInTheDocument();
    // The managers are under Advanced (approved design, 2026-11-04); connecting opens the right one there.
    expect(screen.queryByText('AI helpers: addresses, access tokens and limits')).not.toBeInTheDocument();
    await fireEvent.click(add.getByRole('button', { name: 'Connect by address' }));
    expect(await screen.findByRole('button', { name: 'Advanced', pressed: true })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'AI helpers: addresses, access tokens and limits' })).toBeInTheDocument();
    // …inside Each computer's technical details, which open for it.
    await waitFor(() =>
      expect(
        screen.getByText('Addresses, connection codes and what each computer reported').closest('details'),
      ).toHaveProperty('open', true),
    );

    // Back on Everyday the two ways are still open.
    await fireEvent.click(screen.getByRole('button', { name: 'Everyday' }));
    await fireEvent.click(
      within(screen.getByRole('region', { name: 'Add a computer' })).getByRole('button', {
        name: 'Get a connection code',
      }),
    );
    expect(
      await screen.findByRole('region', { name: 'Studio helpers and their connection codes' }),
    ).toBeInTheDocument();
  });

  it('keeps Everyday to the computers and who does what, and everything else under Advanced', async () => {
    render(ComputersSection, { data: data([entry({})]) });

    expect(screen.getByRole('button', { name: 'Everyday', pressed: true })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Add a computer/ })).toBeInTheDocument();
    // With only this server, Frameleaf Cloud is offered as the other way to go faster.
    expect(screen.getByText('Not set up')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Advanced' }));
    expect(screen.queryByRole('button', { name: /^Add a computer/ })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Each computer' })).toBeInTheDocument();
    // Advanced is the prototype's sections; the operator managers stay closed under Each computer.
    expect(screen.getByText('Studio helpers and their connection codes')).toBeInTheDocument();
    expect(
      screen.getByText('Addresses, connection codes and what each computer reported').closest('details'),
    ).toHaveProperty('open', false);
  });
});
