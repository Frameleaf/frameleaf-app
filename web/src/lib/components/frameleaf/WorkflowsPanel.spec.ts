import { WorkflowIssueCode, WorkflowTrigger, type WorkflowResponseDto } from '@immich/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { authManager } from '$lib/managers/auth-manager.svelte';
import * as utils from '$lib/utils';
import { userAdminFactory } from '@test-data/factories/user-factory';
import en from '../../../../../i18n/en.json';
import WorkflowsPanel from './WorkflowsPanel.svelte';

vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('$lib/managers/plugin-manager.svelte', () => ({
  pluginManager: {
    methods: [],
    triggers: [{ trigger: 'AssetCreate', types: ['AssetV1'] }],
    templates: [],
    ready: () => Promise.resolve(),
  },
}));

const t = en.frameleaf_workflows;

const workflow = (overrides: Partial<WorkflowResponseDto> = {}): WorkflowResponseDto => ({
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Receipts',
  description: null,
  trigger: WorkflowTrigger.AssetCreate,
  enabled: true,
  logging: true,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  extra: {},
  issues: [],
  steps: [],
  ...overrides,
});

beforeEach(() => {
  addMessages('dev', en);
  vi.resetAllMocks();
  sdkMock.getAllTags.mockResolvedValue([]);
  sdkMock.getAllAlbums.mockResolvedValue([]);
  authManager.setUser(userAdminFactory.build({ name: 'Taylor', isAdmin: false }));
});

describe('WorkflowsPanel', () => {
  it('marks a workflow the server can no longer run as blocked, with the reason', () => {
    render(WorkflowsPanel, {
      initial: [
        workflow({
          issues: [
            {
              step: 0,
              code: WorkflowIssueCode.MethodUnavailable,
              message: 'Step 1: this plugin method is unavailable.',
            },
          ],
          steps: [{ id: 'a', method: 'gone#method', config: null, enabled: true, extra: {}, storedSecrets: [] }],
        }),
        workflow({ id: '00000000-0000-4000-8000-000000000002', name: 'Receipts copy', enabled: false }),
      ],
    });

    expect(screen.getByText(/Blocked/)).toBeInTheDocument();
    expect(screen.getByText('Step 1: this plugin method is unavailable.')).toBeInTheDocument();
    expect(screen.getByText(/^Paused/)).toBeInTheDocument();
    expect(screen.getByText(/Taylor · Photo or video uploaded · 1 step/)).toBeInTheDocument();
  });

  it('exports the server’s portable definition with its additional fields', async () => {
    const download = vi.spyOn(utils, 'downloadJson').mockImplementation(() => {});
    sdkMock.getWorkflowForShare.mockResolvedValue({
      name: 'Receipts',
      description: null,
      trigger: 'AssetCreate',
      extra: { source: 'elsewhere' },
      steps: [{ method: 'third-party#faces', config: { minimum: 2 }, extra: { note: 'kept' } }],
    });
    render(WorkflowsPanel, { initial: [workflow()] });

    await fireEvent.click(screen.getByRole('button', { name: 'Export Receipts' }));

    await waitFor(() =>
      expect(download).toHaveBeenCalledWith(
        {
          source: 'elsewhere',
          name: 'Receipts',
          description: null,
          trigger: 'AssetCreate',
          steps: [{ note: 'kept', method: 'third-party#faces', config: { minimum: 2 } }],
        },
        'receipts.json',
      ),
    );
  });

  it('imports a workflow file paused, keeping steps whose method is not installed', async () => {
    render(WorkflowsPanel, { initial: [] });
    const file = new File(
      [
        JSON.stringify({
          name: 'From elsewhere',
          trigger: 'AssetCreate',
          enabled: true,
          steps: [{ method: 'third-party#faces', config: {} }],
        }),
      ],
      'workflow.json',
      { type: 'application/json' },
    );

    // A normal button opens the file chooser (September 24 "Small actions").
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
    await fireEvent.click(screen.getByRole('button', { name: t.import }));
    expect(click).toHaveBeenCalledOnce();
    click.mockRestore();
    await fireEvent.change(screen.getByTestId('workflow-import-input'), { target: { files: [file] } });

    expect(await screen.findByText(t.imported)).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: t.enable_workflow })).not.toBeChecked();
    expect(screen.getByRole('button', { name: /1\. Unavailable plugin method/ })).toBeInTheDocument();
  });

  it('loads its own workflows when mounted without them, and opens one in place', async () => {
    sdkMock.searchWorkflows.mockResolvedValue([workflow()]);
    render(WorkflowsPanel, {});

    await fireEvent.click(await screen.findByRole('button', { name: t.open }));

    expect(sdkMock.searchWorkflows).toHaveBeenCalledWith({});
    expect(screen.getByRole('button', { name: t.tab_steps })).toBeInTheDocument();
    expect(screen.getByLabelText(t.name)).toHaveValue('Receipts');
  });

  it('opens a deep-linked workflow after loading it', async () => {
    sdkMock.searchWorkflows.mockResolvedValue([workflow()]);
    render(WorkflowsPanel, { openId: workflow().id });

    expect(await screen.findByLabelText(t.name)).toHaveValue('Receipts');
  });

  it('shows a loading failure without claiming the library is empty', async () => {
    sdkMock.searchWorkflows.mockRejectedValue(new Error('offline'));
    render(WorkflowsPanel, {});

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText(t.empty)).toBeNull();
  });

  it('refuses to enable a paused workflow the server cannot run', () => {
    render(WorkflowsPanel, {
      initial: [
        workflow({ enabled: false, issues: [{ code: WorkflowIssueCode.TriggerUnavailable, message: 'unavailable' }] }),
      ],
    });
    expect(screen.getByRole('button', { name: t.enable })).toBeDisabled();
  });
});
