import { listRenderWorkers } from '@frameleaf/sdk';
import { render } from '@testing-library/svelte';
import { handleError } from '$lib/utils/handle-error';
import RenderWorkersSection from './RenderWorkersSection.svelte';
import type { RenderWorkersData } from './loaders';

vi.mock('$lib/components/frameleaf/RenderWorkersPanel.svelte', () => ({ default: () => {} }));
vi.mock('$lib/components/frameleaf/RenderLimitsPanel.svelte', () => ({ default: () => {} }));
vi.mock('$lib/components/frameleaf/RenderWorkerAuditPanel.svelte', () => ({ default: () => {} }));
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
