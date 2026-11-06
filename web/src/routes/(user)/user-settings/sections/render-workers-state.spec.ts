import { searchRenderWorkerAudit, type RenderWorkerAuditDto } from '@frameleaf/sdk';
import { handleError } from '$lib/utils/handle-error';
import type { RenderWorkersData } from './loaders';
import { RenderWorkersState } from './render-workers-state.svelte';

vi.mock('$lib/utils/handle-error', async (original) => ({ ...(await original<object>()), handleError: vi.fn() }));
vi.mock('@frameleaf/sdk', async (original) => ({ ...(await original<object>()), searchRenderWorkerAudit: vi.fn() }));

const data = {
  workers: [],
  limits: { instance: null, users: [] },
  audit: [],
  users: [],
} as unknown as RenderWorkersData;
const row = (id: string) => ({ id }) as unknown as RenderWorkerAuditDto;

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

afterEach(() => {
  vi.clearAllMocks();
});

describe('RenderWorkersState.refreshAudit (FL-1251)', () => {
  it('keeps the newest filter’s history when an older answer arrives last', async () => {
    const slow = deferred<RenderWorkerAuditDto[]>();
    const fast = deferred<RenderWorkerAuditDto[]>();
    vi.mocked(searchRenderWorkerAudit)
      .mockReturnValueOnce(slow.promise as never)
      .mockReturnValueOnce(fast.promise as never);
    const state = new RenderWorkersState(data, () => 'failed');

    const first = state.refreshAudit('a');
    const second = state.refreshAudit('b');
    fast.resolve([row('b')]);
    await second;
    expect(state.audit).toEqual([row('b')]);
    expect(state.refreshing).toBe(false);

    slow.resolve([row('a')]);
    await first;
    expect(state.audit).toEqual([row('b')]);
    expect(state.auditWorkerId).toBe('b');
  });

  it('stays refreshing until the newest request answers, and ignores an older failure', async () => {
    const slow = deferred<RenderWorkerAuditDto[]>();
    const fast = deferred<RenderWorkerAuditDto[]>();
    vi.mocked(searchRenderWorkerAudit)
      .mockReturnValueOnce(fast.promise as never)
      .mockReturnValueOnce(slow.promise as never);
    const state = new RenderWorkersState(data, () => 'failed');

    const first = state.refreshAudit('a');
    const second = state.refreshAudit('b');
    fast.reject(new Error('offline'));
    await first;
    expect(state.refreshing).toBe(true);
    expect(handleError).not.toHaveBeenCalled();

    slow.resolve([row('b')]);
    await second;
    expect(state.refreshing).toBe(false);
    expect(state.audit).toEqual([row('b')]);
  });
});
