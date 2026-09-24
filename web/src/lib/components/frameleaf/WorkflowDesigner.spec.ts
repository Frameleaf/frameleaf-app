import {
  WorkflowResult,
  WorkflowRunErrorCode,
  WorkflowTrigger,
  WorkflowType,
  type PluginMethodResponseDto,
  type WorkflowResponseDto,
} from '@immich/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { draftFromWorkflow } from '$lib/frameleaf/workflows';
import en from '../../../../../i18n/en.json';
import WorkflowDesigner from './WorkflowDesigner.svelte';

const t = en.frameleaf_workflows;
const id = '00000000-0000-4000-8000-000000000010';
const runId = '00000000-0000-4000-8000-000000000020';
const assetId = '00000000-0000-4000-8000-000000000030';

const webhook = (properties: Record<string, unknown>, required: string[] = []): PluginMethodResponseDto => ({
  key: 'immich-plugin-core#webhook',
  name: 'webhook',
  title: 'Trigger Webhook',
  description: 'Send a request',
  types: [WorkflowType.AssetV1],
  uiHints: [],
  hostFunctions: true,
  allowedHosts: ['hooks.example.test'],
  schema: { type: 'object', properties, required },
});

const workflow = (overrides: Partial<WorkflowResponseDto> = {}): WorkflowResponseDto => ({
  id,
  name: 'Notify',
  description: null,
  trigger: WorkflowTrigger.AssetCreate,
  enabled: true,
  logging: true,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  extra: {},
  issues: [],
  steps: [
    {
      id: '00000000-0000-4000-8000-000000000011',
      method: 'immich-plugin-core#webhook',
      config: { url: 'https://hooks.example.test' },
      enabled: true,
      extra: {},
      storedSecrets: ['headerValue'],
    },
    {
      id: '00000000-0000-4000-8000-000000000012',
      method: 'third-party#faces',
      config: { minimum: 2 },
      enabled: false,
      extra: { note: 'kept' },
      storedSecrets: [],
    },
  ],
  ...overrides,
});

const triggers = [{ trigger: WorkflowTrigger.AssetCreate, types: [WorkflowType.AssetV1] }];

const setup = (methods: PluginMethodResponseDto[], stored = workflow()) =>
  render(WorkflowDesigner, {
    open: true,
    workflow: stored,
    initial: draftFromWorkflow(stored),
    methods,
    triggers,
    templates: [],
    onSaved: vi.fn(),
    onDeleted: vi.fn(),
  });

beforeEach(() => {
  addMessages('dev', en);
  vi.resetAllMocks();
});

afterEach(() => vi.unstubAllGlobals());

describe('WorkflowDesigner', () => {
  it('edits parameters from the installed method schema and follows a schema change', async () => {
    const { rerender } = setup([webhook({ url: { type: 'string', title: 'URL' } }, ['url'])]);

    expect(screen.getByLabelText('URL *')).toHaveValue('https://hooks.example.test');
    expect(screen.getByText(/Can send requests to: hooks.example.test/)).toBeInTheDocument();

    await rerender({
      methods: [
        webhook({ url: { type: 'string', title: 'Address' }, retries: { type: 'integer', title: 'Retries' } }, [
          'url',
          'retries',
        ]),
      ],
    });

    expect(screen.getByLabelText('Address *')).toBeInTheDocument();
    expect(screen.getByLabelText('Retries *')).toBeInTheDocument();
    // the missing required value now blocks the enabled workflow from being saved
    expect(screen.getByText(/Pause this workflow before saving. Step 1: .*Retries is required/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t.save })).toBeDisabled();
  });

  it('keeps a step whose method is not installed and says so', async () => {
    setup([webhook({ url: { type: 'string', title: 'URL' } })], workflow({ enabled: false }));

    await fireEvent.click(screen.getByRole('button', { name: /2\. Unavailable plugin method/ }));

    expect(screen.getByText(t.method_not_installed)).toBeInTheDocument();
    expect(screen.getByText('third-party#faces')).toBeInTheDocument();
    // an unavailable step keeps the workflow from being enabled
    expect(screen.getByRole('checkbox', { name: t.enable_workflow })).toBeDisabled();
  });

  it('lists the problems instead of a preview when the definition cannot run', async () => {
    setup([webhook({ url: { type: 'string', title: 'URL' } })], workflow({ enabled: false }));

    await fireEvent.click(screen.getByRole('button', { name: t.tab_validation }));
    await fireEvent.click(screen.getByRole('button', { name: t.validate }));

    expect(screen.getByRole('status')).toHaveTextContent(/Step 2: this plugin method is unavailable/);
    expect(screen.queryByText(t.preview_step_validated)).toBeNull();
  });

  it('checks and previews a runnable definition step by step without running it (FL-82)', async () => {
    const stored = workflow({
      enabled: false,
      steps: [
        { ...workflow().steps[0], enabled: true },
        { ...workflow().steps[0], id: '00000000-0000-4000-8000-000000000013', enabled: false },
      ],
    });
    setup([webhook({ url: { type: 'string', title: 'URL' } })], stored);

    await fireEvent.click(screen.getByRole('button', { name: t.tab_validation }));
    await fireEvent.click(screen.getByRole('button', { name: t.validate }));

    const status = screen.getByRole('status');
    expect(status).toHaveTextContent(t.validation_ok);
    const steps = [...status.querySelectorAll(':scope ol li')].map((item) =>
      item.textContent?.replaceAll(/\s+/g, ' ').trim(),
    );
    expect(steps).toEqual([
      `Trigger Webhook ${t.preview_step_validated}`,
      `Trigger Webhook ${t.preview_step_disabled}`,
    ]);
    expect(status).toHaveTextContent(t.preview_run_needs);
    // A dry run never reaches the server.
    expect(sdkMock.updateWorkflow).not.toHaveBeenCalled();
  });

  it('never shows a stored credential, only that one is kept', () => {
    setup([webhook({ url: { type: 'string', title: 'URL' }, headerValue: { type: 'string', title: 'Header value' } })]);

    expect(screen.getByLabelText('Header value')).toHaveValue('');
    expect(screen.getByText(t.stored_secret)).toBeInTheDocument();
  });

  it('shows a failed run with its reason and retries it', async () => {
    sdkMock.getWorkflowLogs.mockResolvedValue([
      {
        id: '00000000-0000-4000-8000-000000000040',
        at: '2026-09-22T10:00:00.000Z',
        result: WorkflowResult.Error,
        runId,
        attempt: 1,
        errorCode: WorkflowRunErrorCode.StepFailed,
        error: 'Webhook answered 500',
        triggerDataId: assetId,
        lastStep: { index: 0, method: 'x' },
      },
      {
        id: '00000000-0000-4000-8000-000000000041',
        at: '2026-09-22T09:00:00.000Z',
        result: WorkflowResult.Error,
        runId: '00000000-0000-4000-8000-000000000021',
        attempt: 0,
        errorCode: WorkflowRunErrorCode.Unsupported,
        error: 'Step 2: this plugin method is unavailable. Its definition is retained.',
      },
    ]);
    sdkMock.retryWorkflowRun.mockResolvedValue(undefined as never);
    setup([webhook({ url: { type: 'string', title: 'URL' } })]);

    await fireEvent.click(screen.getByRole('button', { name: t.tab_history }));

    expect(await screen.findByText('Webhook answered 500')).toBeInTheDocument();
    expect(screen.getByText(t.attempt_retry)).toBeInTheDocument();
    expect(screen.getByText(t.not_run)).toBeInTheDocument();
    expect(sdkMock.getWorkflowLogs).toHaveBeenCalledWith({ id, limit: 50, before: undefined, result: undefined });

    const retries = screen.getAllByRole('button', { name: t.retry });
    expect(retries).toHaveLength(1);
    await fireEvent.click(retries[0]);

    expect(sdkMock.retryWorkflowRun).toHaveBeenCalledWith({ id, runId });
    expect(await screen.findByText(t.retry_queued)).toBeInTheDocument();
  });

  it('keeps the draft open with the server’s reason when saving fails', async () => {
    sdkMock.updateWorkflow.mockRejectedValue(
      Object.assign(new Error('Bad Request'), { data: { message: 'Pause this workflow before saving.' }, status: 400 }),
    );
    setup([webhook({ url: { type: 'string', title: 'URL' } })], workflow({ enabled: false }));

    await fireEvent.input(screen.getByLabelText(t.name), { target: { value: 'Renamed' } });
    await fireEvent.click(screen.getByRole('button', { name: t.save }));

    await waitFor(() => expect(sdkMock.updateWorkflow).toHaveBeenCalled());
    const [{ workflowUpdateDto }] = sdkMock.updateWorkflow.mock.calls[0];
    expect(workflowUpdateDto).toMatchObject({
      name: 'Renamed',
      steps: [
        { id: '00000000-0000-4000-8000-000000000011', config: { url: 'https://hooks.example.test' } },
        { method: 'third-party#faces', extra: { note: 'kept' }, enabled: false },
      ],
    });
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByLabelText(t.name)).toHaveValue('Renamed');
  });

  it('guards X against discarding an edited draft', async () => {
    const confirm = vi.fn().mockReturnValue(false);
    vi.stubGlobal('confirm', confirm);
    setup([webhook({ url: { type: 'string', title: 'URL' } })]);

    await fireEvent.input(screen.getByLabelText(t.name), { target: { value: 'Changed' } });
    await fireEvent.click(screen.getByRole('button', { name: en.close }));

    expect(confirm).toHaveBeenCalledWith(t.discard_prompt);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('guards Escape against discarding unapplied workflow JSON', async () => {
    const confirm = vi.fn().mockReturnValue(false);
    vi.stubGlobal('confirm', confirm);
    setup([webhook({ url: { type: 'string', title: 'URL' } })]);

    await fireEvent.click(screen.getByRole('button', { name: t.tab_json }));
    await fireEvent.input(screen.getByLabelText(t.json_label), { target: { value: '{"draft":"pending"}' } });
    const cancelEvent = new Event('cancel', { cancelable: true });
    await fireEvent(screen.getByRole('dialog'), cancelEvent);

    expect(cancelEvent.defaultPrevented).toBe(true);
    expect(confirm).toHaveBeenCalledWith(t.discard_prompt);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('guards footer Cancel against discarding unapplied parameter JSON', async () => {
    const confirm = vi.fn().mockReturnValue(false);
    vi.stubGlobal('confirm', confirm);
    setup([webhook({ url: { type: 'string', title: 'URL' } })]);

    await fireEvent.click(screen.getByText(t.method_json));
    await fireEvent.click(screen.getByRole('button', { name: t.edit_parameter_json }));
    await fireEvent.input(screen.getByLabelText(t.parameter_json), { target: { value: '{"url":"https://new.test"}' } });
    await fireEvent.click(screen.getByRole('button', { name: t.cancel }));

    expect(confirm).toHaveBeenCalledWith(t.discard_prompt);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
