import { MediaOperationKind, MlWorkerReadiness, WorkerInventorySource } from '@frameleaf/sdk';
import { fireEvent, render, screen, within } from '@testing-library/svelte';
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

const computer = (name: string) =>
  screen.getByText(name, { selector: '.kit-item strong' }).closest('li') as HTMLElement;

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

    expect(screen.getByRole('heading', { name: 'This server does all the work' })).toBeInTheDocument();
    expect(within(computer('This server')).getByText('Ready')).toBeInTheDocument();
    expect(within(computer('This server')).getByText('Built in')).toBeInTheDocument();
    expect(within(computer('This server')).getByText('2 kinds of work')).toBeInTheDocument();
    expect(await screen.findByText('No computer yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Add a computer' })).toHaveAttribute('href', '#add-a-computer');
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

    expect(screen.getByRole('heading', { name: '2 computers are ready' })).toBeInTheDocument();
    expect(screen.getAllByText('Office PC', { selector: '.kit-item strong' })).toHaveLength(1);
    const office = within(computer('Office PC'));
    expect(office.getByText('At home · GeForce RTX 3060')).toBeInTheDocument();
    expect(office.getByText('Ready')).toBeInTheDocument();
    expect(office.getByText('3 kinds of work')).toBeInTheDocument();
    expect(office.getByText('AI features and Studio and restoration')).toBeInTheDocument();
    // Who does Studio exports is the same answer the other pages give.
    const status = within(screen.getByRole('region', { name: 'Computers status' }));
    expect(await status.findByText('Office PC')).toBeInTheDocument();
  });

  it('says plainly when a helper is not answering', () => {
    render(ComputersSection, {
      data: data([
        entry({}),
        entry({ id: 'o1', name: 'Office PC', kind: 'lan', readiness: MlWorkerReadiness.Unreachable }),
      ]),
    });

    expect(screen.getByRole('heading', { name: 'Office PC isn’t answering' })).toBeInTheDocument();
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

    const add = within(screen.getByRole('region', { name: 'Add a computer' }));
    expect(add.getByText(/Frameleaf helper for Mac and Windows is not available yet/)).toBeInTheDocument();
    expect(add.queryByRole('textbox')).not.toBeInTheDocument();
    const details = screen.getByText('AI helpers: addresses, access tokens and limits').closest('details')!;
    expect(details).not.toHaveAttribute('open');
    await fireEvent.click(add.getByRole('button', { name: 'Connect by address' }));
    expect(details).toHaveAttribute('open');

    const studio = screen.getByText(/^Studio helpers:/).closest('details')!;
    await fireEvent.click(add.getByRole('button', { name: 'Get a connection code' }));
    expect(studio).toHaveAttribute('open');
  });
});
