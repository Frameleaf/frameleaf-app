import { listRenderWorkers } from '@frameleaf/sdk';
import { render } from '@testing-library/svelte';
import { handleError } from '$lib/utils/handle-error';
import RenderWorkersSection from './RenderWorkersSection.svelte';
import type { RenderWorkersData } from './loaders';

vi.mock('$lib/components/frameleaf/RenderWorkersPanel.svelte', () => ({ default: () => {} }));
vi.mock('$lib/components/frameleaf/RenderLimitsPanel.svelte', () => ({ default: () => {} }));
vi.mock('$lib/components/frameleaf/RenderWorkerAuditPanel.svelte', () => ({ default: () => {} }));
const formDialog = vi.hoisted(() => vi.fn());
vi.mock('$lib/components/frameleaf/RenderWorkerFormDialog.svelte', () => ({ default: formDialog }));
vi.mock('$lib/utils/handle-error', async (original) => ({ ...(await original<object>()), handleError: vi.fn() }));
vi.mock('@frameleaf/sdk', async (original) => ({ ...(await original<object>()), listRenderWorkers: vi.fn() }));

const data = {
  workers: [],
  limits: { instance: null, users: [] },
  audit: [],
  users: [],
} as unknown as RenderWorkersData;

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

it('reports a failing worker poll once until it recovers', async () => {
  vi.useFakeTimers();
  vi.mocked(listRenderWorkers)
    .mockRejectedValueOnce(new Error('offline'))
    .mockRejectedValueOnce(new Error('offline'))
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce([])
    .mockRejectedValueOnce(new Error('offline again'));

  render(RenderWorkersSection, { data });
  await vi.advanceTimersByTimeAsync(90_000);
  expect(handleError).toHaveBeenCalledTimes(1);

  await vi.advanceTimersByTimeAsync(60_000);
  expect(handleError).toHaveBeenCalledTimes(2);
});

it('opens the connect form only for a request raised while it is shown, not one from before (FL-1250)', async () => {
  vi.mocked(listRenderWorkers).mockResolvedValue([]);
  const { rerender } = render(RenderWorkersSection, { data, part: 'helpers', enrolRequest: 1 });
  await Promise.resolve();
  expect(formDialog).not.toHaveBeenCalled();

  await rerender({ enrolRequest: 2 });
  expect(formDialog).toHaveBeenCalledTimes(1);
});
