import type { WorkflowBatchResponseDto, WorkflowResponseDto } from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import en from '../../../../../i18n/en.json';
import WorkflowBatches from './WorkflowBatches.svelte';

const workflow = { id: 'workflow-id', enabled: true, issues: [] } as unknown as WorkflowResponseDto;
const batch: WorkflowBatchResponseDto = {
  id: 'batch-id',
  workflowId: workflow.id,
  status: 'running' as WorkflowBatchResponseDto['status'],
  reason: 'manual' as WorkflowBatchResponseDto['reason'],
  createdAt: '2026-10-28T00:00:00Z',
  updatedAt: '2026-10-28T00:00:00Z',
  snapshotAt: '2026-10-28T00:00:00Z',
  finishedAt: null,
  error: null,
  total: 25_001,
  completed: 2,
  skipped: 1,
  failed: 0,
};
beforeEach(() => {
  vi.resetAllMocks();
  addMessages('dev', en);
  sdkMock.getWorkflowBatches.mockResolvedValue([]);
});

it('starts a saved workflow and cancels only its active batch, retaining displayed progress', async () => {
  sdkMock.runWorkflow.mockResolvedValue(batch);
  render(WorkflowBatches, { workflow, dirty: false });
  const start = screen.getByRole('button', { name: en.frameleaf_workflows.run_now });
  await waitFor(() => expect(start).toBeEnabled());
  sdkMock.getWorkflowBatches.mockResolvedValue([batch]);
  await fireEvent.click(start);
  expect(await screen.findByText(/2 completed.*1 skipped/)).toBeInTheDocument();
  expect(sdkMock.runWorkflow).toHaveBeenCalledExactlyOnceWith({ id: workflow.id });
  sdkMock.cancelWorkflowBatch.mockResolvedValue({
    ...batch,
    status: 'cancelled' as WorkflowBatchResponseDto['status'],
  });
  await fireEvent.click(screen.getByRole('button', { name: en.cancel }));
  expect(sdkMock.cancelWorkflowBatch).toHaveBeenCalledExactlyOnceWith({ id: workflow.id, batchId: batch.id });
  expect(sdkMock.deleteWorkflow).not.toHaveBeenCalled();
});

it('requires saving a changed definition before Run now', async () => {
  render(WorkflowBatches, { workflow, dirty: true });
  await waitFor(() => expect(sdkMock.getWorkflowBatches).toHaveBeenCalled());
  expect(screen.getByRole('button', { name: en.frameleaf_workflows.run_now })).toBeDisabled();
  expect(screen.getByText(en.frameleaf_workflows.save_before_run)).toBeInTheDocument();
});
