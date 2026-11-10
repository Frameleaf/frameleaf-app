import {
  AssetTypeEnum,
  createJob,
  deferImageDescriptionRequeue,
  emptyQueue,
  getAssetInfo,
  getImageDescriptionRequeueEstimate,
  getMachineLearningHardware,
  MachineLearningHardwareAcceleration,
  getQueueJobs,
  ManualJobName,
  JobName,
  QueueCommand,
  QueueJobStatus,
  QueueJobWorkerKind,
  QueueName,
  getQueueOwnerStatistics,
  retryFailedQueueJobs,
  retryQueueJob,
  runQueueOnOne,
  searchAssets,
  startQueueJob,
  runQueueCommandLegacy,
  searchUsersAdmin,
  SmartAlbumBuiltInKind,
  triggerImageDescriptionRequeue,
  triggerSmartAlbumReevaluate,
  updateQueue,
  type QueueResponseDto,
} from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { tick } from 'svelte';
import { addMessages } from 'svelte-i18n';
import { goto } from '$app/navigation';
import JobsManager from '$lib/components/frameleaf/JobsManager.svelte';
import { queueManager } from '$lib/managers/queue-manager.svelte';
import en from '../../../../../i18n/en.json';

const state = vi.hoisted(() => ({ url: new URL('https://example.test/user-settings?area=processing&section=queues') }));
const queues = vi.hoisted(() => ({ list: [] as QueueResponseDto[], changed: () => {} }));

vi.mock('$app/state', () => ({
  page: {
    get url() {
      return state.url;
    },
  },
}));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('@frameleaf/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@frameleaf/sdk')>()),
  listDurableJobRuns: vi.fn().mockResolvedValue({ items: [], hasNextPage: false }),
  listDurableJobRunItems: vi.fn().mockResolvedValue({ items: [], hasNextPage: false }),
  getQueueJobs: vi.fn(),
  getAssetInfo: vi.fn(),
  runQueueCommandLegacy: vi.fn(),
  updateQueue: vi.fn(),
  emptyQueue: vi.fn(),
  getQueue: vi.fn(),
  createJob: vi.fn(),
  retryFailedQueueJobs: vi.fn(),
  retryQueueJob: vi.fn(),
  listMlDestinations: vi.fn().mockResolvedValue([]),
  getMlWorkloadRoutes: vi.fn().mockResolvedValue({ routes: [] }),
  startQueueJob: vi.fn(),
  runQueueOnOne: vi.fn(),
  searchAssets: vi.fn().mockResolvedValue({
    assets: { items: [{ id: '9a1d7c6e-2b0f-4c55-9b0e-6b8f2c1c1a02', originalFileName: 'IMG_7.jpg', type: 'IMAGE' }] },
  }),
  searchUsersAdmin: vi.fn(),
  getQueueOwnerStatistics: vi.fn(),
  triggerImageDescriptionRequeue: vi.fn(),
  deferImageDescriptionRequeue: vi.fn(),
  getImageDescriptionRequeueEstimate: vi.fn(),
  triggerSmartAlbumReevaluate: vi.fn(),
  getMachineLearningHardware: vi.fn(),
  // FL-164: the Frameleaf Cloud group reads the backup status; nothing is in progress here
  getCloudBackupStatus: vi.fn().mockResolvedValue({ activeRun: null, activeRestore: null }),
}));
vi.mock('$lib/frameleaf/job-history', async (importOriginal) => {
  const original = await importOriginal<typeof import('$lib/frameleaf/job-history')>();
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (k: string, v: string) => values.set(k, v),
  };
  return {
    ...original,
    readJobHistory: () => original.readJobHistory(storage),
    recordJobHistory: (entry: Parameters<typeof original.recordJobHistory>[0]) =>
      original.recordJobHistory(entry, storage),
  };
});
vi.mock('$lib/managers/queue-manager.svelte', async () => {
  const { createSubscriber } = await import('svelte/reactivity');
  const subscribe = createSubscriber((update) => {
    queues.changed = update;
  });
  return {
    queueManager: {
      get queues() {
        subscribe();
        return queues.list;
      },
      // One answer from the server: the page is past its first load.
      snapshots: [{ timestamp: 0, snapshot: [] }],
      listen: () => () => {},
      refresh: vi.fn(),
    },
  };
});
vi.mock('$lib/managers/feature-flags-manager.svelte', () => ({
  featureFlagsManager: {
    value: { facialRecognition: true, smartSearch: true, duplicateDetection: true, ocr: false, sidecar: true },
  },
}));
vi.mock('$lib/managers/event-manager.svelte', () => ({
  eventManager: { emit: vi.fn(), on: vi.fn(() => () => {}) },
}));

const queue = (name: QueueName, statistics: Partial<QueueResponseDto['statistics']> = {}, isPaused = false) => ({
  name,
  isPaused,
  hasUnfinishedWork:
    (statistics.active ?? 0) + (statistics.waiting ?? 0) + (statistics.delayed ?? 0) + (statistics.paused ?? 0) > 0,
  statistics: { active: 0, completed: 0, delayed: 0, failed: 0, paused: 0, waiting: 0, ...statistics },
});

const at = (search: string) => {
  state.url = new URL(`https://example.test/user-settings?area=processing&section=queues${search}`);
};

beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false;
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  addMessages('dev', en);
  // These cases are the page as it was, which is now Background work › Advanced (approved design, 2026-11-04).
  at('&view=advanced');
  queues.list = [
    queue(QueueName.ThumbnailGeneration, { active: 2, waiting: 5, completed: 40 }),
    queue(QueueName.FaceDetection, { failed: 3, delayed: 1 }),
    queue(QueueName.Ocr, {}, true),
    queue(QueueName.BackgroundTask, { active: 1 }),
  ];
  vi.mocked(getQueueJobs).mockResolvedValue([]);
  vi.mocked(getMachineLearningHardware).mockResolvedValue({
    preferredAcceleration: MachineLearningHardwareAcceleration.Auto,
  } as never);
  vi.mocked(getImageDescriptionRequeueEstimate).mockResolvedValue({
    totalAssets: 120,
    estimatedTotalSeconds: 600,
  } as never);
  vi.mocked(searchUsersAdmin).mockResolvedValue([
    { id: 'ada', name: 'Ada Lovelace' },
    { id: 'grace', name: 'Grace Hopper' },
  ] as never);
});

describe('Job manager (FL-71, JobsManager.jsx)', () => {
  it('lists every task with its feature, status, counts and how many run at once (approved design, 2026-11-04)', () => {
    render(JobsManager);

    // The page's heading is the settings host's; Advanced names itself under the Everyday | Advanced switch.
    expect(screen.getByRole('button', { name: 'Advanced', pressed: true })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Every task' })).toBeInTheDocument();
    for (const label of ['Resume 1 paused', 'Pause everything', 'Enrichment tasks', 'Create job']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }
    // Concurrency edits the settings draft, so it shows only once the settings have loaded.
    expect(screen.queryByRole('button', { name: /^Concurrency/ })).not.toBeInTheDocument();
    const failed = screen.getByText('Failed', { selector: '.jm-metric span' }).nextElementSibling;
    expect(failed).toHaveTextContent('3');

    const table = screen.getByRole('table');
    for (const column of ['Work', 'Status', 'Active', 'Waiting', 'Failed', 'At once']) {
      expect(within(table).getByRole('columnheader', { name: column })).toBeInTheDocument();
    }
    const [, ...rows] = within(table).getAllByRole('row');
    expect(rows.map((row) => row.querySelector('[aria-label^="Open "]')?.getAttribute('aria-label'))).toEqual([
      'Open Making thumbnails',
      'Open Finding faces',
      'Open Housekeeping',
      'Open Reading text in photos',
    ]);
    // Each task names the feature it belongs to, as everywhere else.
    expect(within(rows[0]).getByText('Ready to browse')).toBeInTheDocument();
    expect(within(rows[1]).getByText('Faces & identity')).toBeInTheDocument();
    expect(within(rows[3]).getByText('Text, documents & receipts · feature off')).toBeInTheDocument();
    expect(within(rows[0]).getByText('Processing')).toBeInTheDocument();
    expect(within(rows[3]).getByText('Paused')).toBeInTheDocument();
    expect(within(rows[1]).getByRole('button', { name: '3' })).toBeEnabled();
    expect(within(rows[0]).getByRole('button', { name: 'Pause Making thumbnails' })).toBeEnabled();
    expect(within(rows[2]).getByRole('button', { name: 'Pause Housekeeping' })).toBeDisabled();
    expect(within(rows[3]).getByRole('button', { name: 'Resume Reading text in photos' })).toBeEnabled();
    expect(screen.getByText('4 of 4 tasks')).toBeInTheDocument();
  });

  it('shows photo-details follow-up steps as their own count, so the photos still to read visibly fall (FL-1272)', () => {
    queues.list = [queue(QueueName.MetadataExtraction, { active: 4, waiting: 608_111, followUp: 59_271 })];
    render(JobsManager);

    const waiting = screen.getByText('Waiting & scheduled', { selector: '.jm-metric span' }).parentElement!;
    expect(waiting).toHaveTextContent('548,840');
    expect(waiting).toHaveTextContent('+59,271 finishing up');
    const [, row] = within(screen.getByRole('table')).getAllByRole('row');
    expect(within(row).getByText('548,840')).toBeInTheDocument();
    expect(within(row).getByText('+59,271 finishing up')).toBeInTheDocument();
  });

  it("shows one feature's tasks, filters by status, and opens a task on its failed jobs", async () => {
    at('&view=advanced&feature=faces');
    const { unmount } = render(JobsManager);

    expect(screen.getByRole('combobox', { name: 'Feature' })).toHaveValue('faces');
    expect(screen.getByRole('button', { name: 'Open Finding faces' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open Making thumbnails' })).not.toBeInTheDocument();
    expect(screen.getByText('1 of 4 tasks')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: '3' }));
    await waitFor(() =>
      expect(goto).toHaveBeenCalledWith(expect.stringContaining('queue=face-detection&tab=failed'), expect.anything()),
    );
    unmount();

    at('&view=advanced');
    render(JobsManager);
    await fireEvent.change(screen.getByRole('combobox', { name: 'Status' }), { target: { value: 'paused' } });
    expect(screen.getByRole('button', { name: 'Open Reading text in photos' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open Finding faces' })).not.toBeInTheDocument();
  });

  it('pauses everything after its review, leaving out what the server never pauses', async () => {
    queues.list = [queue(QueueName.ThumbnailGeneration, { active: 2 }), queue(QueueName.BackgroundTask, { active: 1 })];
    vi.mocked(updateQueue).mockResolvedValue(queue(QueueName.ThumbnailGeneration, {}, true));
    render(JobsManager);

    await fireEvent.click(screen.getByRole('button', { name: 'Pause everything' }));
    const review = screen.getByRole('dialog', { name: 'Pause everything' });
    expect(within(review).getByText('1 item')).toBeInTheDocument();
    await fireEvent.click(within(review).getByRole('button', { name: 'Pause everything' }));

    await waitFor(() => expect(updateQueue).toHaveBeenCalledTimes(1));
    expect(updateQueue).toHaveBeenCalledWith({
      name: QueueName.ThumbnailGeneration,
      queueUpdateDto: { isPaused: true },
    });
  });

  it('pauses a queue after its review', async () => {
    vi.mocked(updateQueue).mockResolvedValue(queue(QueueName.ThumbnailGeneration, {}, true));
    at('&queue=thumbnail-generation');
    render(JobsManager);

    // One task's screen sits under Advanced, named with its feature, with the way back to every task.
    expect(screen.getByText('Advanced · part of Ready to browse')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'All tasks' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Advanced', pressed: true })).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    const review = screen.getByRole('dialog', { name: 'Pause queue' });
    expect(within(review).getByText(/Stop taking new work/)).toBeInTheDocument();
    await fireEvent.click(within(review).getByRole('button', { name: 'Pause queue' }));

    await waitFor(() =>
      expect(updateQueue).toHaveBeenCalledWith({
        name: QueueName.ThumbnailGeneration,
        queueUpdateDto: { isPaused: true },
      }),
    );
    expect(await screen.findByText('Pause queue: request sent to the server.')).toBeInTheDocument();
  });

  it('opens one queue on its failed jobs and removes them only after acknowledging the review', async () => {
    at('&queue=face-detection&tab=failed');
    vi.mocked(getQueueJobs).mockResolvedValue([
      {
        id: 'job-1',
        name: JobName.AssetDetectFaces,
        timestamp: Date.UTC(2026, 8, 23, 10),
        data: { id: 'asset-1' },
        attemptsMade: 3,
        failedReason: 'Machine learning is unreachable',
        worker: { kind: QueueJobWorkerKind.Server, name: null },
      },
    ]);
    render(JobsManager);

    expect(screen.getByRole('heading', { level: 2, name: 'Finding faces' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Failed\s*3/ })).toHaveAttribute('aria-selected', 'true');
    const job = await screen.findByRole('button', {
      name: /^Detect faces\s*asset-1\s*Machine learning is unreachable$/,
    });
    // The job detail shows its attempts and last error, as the template's does.
    await fireEvent.click(job);
    const detail = screen.getByRole('dialog', { name: 'Detect faces' });
    expect(within(detail).getByText('Attempt').nextElementSibling).toHaveTextContent('3');
    expect(within(detail).getByRole('heading', { name: 'Last error' })).toBeInTheDocument();
    expect(within(detail).getByText('Machine learning is unreachable')).toBeInTheDocument();
    queues.list = queues.list.map((item) => ({ ...item, statistics: { ...item.statistics } }));
    queues.changed();
    await tick();
    expect(screen.getByRole('dialog', { name: 'Detect faces' })).toBeVisible();
    await fireEvent.click(within(detail).getByRole('button', { name: 'Done' }));
    await waitFor(() =>
      expect(getQueueJobs).toHaveBeenCalledWith({ name: QueueName.FaceDetection, status: [QueueJobStatus.Failed] }),
    );

    await fireEvent.click(screen.getByRole('button', { name: 'Stop trying these' }));
    const review = screen.getByRole('dialog', { name: 'Stop trying these' });
    const confirm = within(review).getByRole('button', { name: 'Stop trying these' });
    expect(confirm).toBeDisabled();
    await fireEvent.click(within(review).getByRole('checkbox'));
    await fireEvent.click(confirm);

    await waitFor(() =>
      expect(runQueueCommandLegacy).toHaveBeenCalledWith({
        name: QueueName.FaceDetection,
        queueCommandDto: { command: QueueCommand.ClearFailed, force: false },
      }),
    );
    expect(emptyQueue).not.toHaveBeenCalled();
  });

  it('keeps the face reset behind an acknowledged review and waits for a busy queue', async () => {
    queues.list = [queue(QueueName.FaceDetection)];
    at('&queue=face-detection');
    render(JobsManager);

    expect(screen.getByRole('button', { name: 'Catch up' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Refresh faces' })).toBeEnabled();
    await fireEvent.click(screen.getByRole('button', { name: 'Start again from scratch' }));
    const review = screen.getByRole('dialog', { name: 'Start again from scratch' });
    expect(within(review).getByText(/Reset generated face results/)).toBeInTheDocument();
    await fireEvent.click(within(review).getByRole('checkbox'));
    await fireEvent.click(within(review).getByRole('button', { name: 'Start again from scratch' }));

    await waitFor(() =>
      expect(runQueueCommandLegacy).toHaveBeenCalledWith({
        name: QueueName.FaceDetection,
        queueCommandDto: { command: QueueCommand.Start, force: true },
      }),
    );
  });

  it('does not offer a start while the queue still has work', () => {
    queues.list = [queue(QueueName.ThumbnailGeneration, { waiting: 2 })];
    at('&queue=thumbnail-generation&tab=waiting');
    render(JobsManager);

    expect(screen.getByRole('button', { name: 'Catch up' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Clear waiting work' })).toBeEnabled();
  });

  it('states the server limit when more failed records exist than one removal clears', async () => {
    queues.list = [queue(QueueName.FaceDetection, { failed: 1500 })];
    at('&queue=face-detection&tab=failed');
    render(JobsManager);

    await fireEvent.click(screen.getByRole('button', { name: 'Stop trying these' }));
    const review = screen.getByRole('dialog', { name: 'Stop trying these' });
    expect(within(review).getByText('1,000 items')).toBeInTheDocument();
    expect(
      within(review).getByText(/removes up to 1,000 failed records at a time; this queue has 1,500/),
    ).toBeInTheDocument();
  });

  it('creates a maintenance job from the template dialog through the review, and records it in the history', async () => {
    render(JobsManager);

    await fireEvent.click(screen.getByRole('button', { name: 'Create job' }));
    const dialog = screen.getByRole('dialog', { name: 'Create a maintenance job' });
    await fireEvent.input(within(dialog).getByRole('searchbox', { name: 'Search maintenance jobs' }), {
      target: { value: 'deleted accounts' },
    });
    const task = within(dialog).getByRole('radio', { name: /Clean up deleted accounts/ });
    expect(within(dialog).getByText('Housekeeping · review required')).toBeInTheDocument();
    await fireEvent.click(task);
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Review job' }));

    const review = screen.getByRole('dialog', { name: 'Clean up deleted accounts' });
    const confirm = within(review).getByRole('button', { name: 'Clean up deleted accounts' });
    expect(confirm).toBeDisabled();
    await fireEvent.click(within(review).getByRole('checkbox'));
    await fireEvent.click(confirm);

    await waitFor(() => expect(createJob).toHaveBeenCalledWith({ jobCreateDto: { name: ManualJobName.UserCleanup } }));
    const history = screen.getByText('Queue action history').closest('details')!;
    expect(within(history).getByText('Clean up deleted accounts')).toBeInTheDocument();
    expect(within(history).getByText('Housekeeping · 1 item · all accounts')).toBeInTheDocument();
  });

  it('sends queue commands only through the review and never offers pausing background tasks', async () => {
    queues.list = [queue(QueueName.BackgroundTask, { waiting: 2, failed: 1 })];
    at('&queue=background-task&tab=failed');
    render(JobsManager);

    expect(screen.getByRole('button', { name: 'Pause' })).toBeDisabled();
    await fireEvent.click(screen.getByRole('button', { name: 'Stop trying these' }));
    expect(screen.getByRole('dialog', { name: 'Stop trying these' })).toBeInTheDocument();
    expect(runQueueCommandLegacy).not.toHaveBeenCalled();
    expect(emptyQueue).not.toHaveBeenCalled();
  });

  it("names each job's account and worker, as the template's jobs table does", async () => {
    at('&queue=face-detection&tab=failed');
    vi.mocked(getQueueJobs).mockResolvedValue([
      {
        id: 'job-1',
        name: JobName.AssetDetectFaces,
        timestamp: Date.UTC(2026, 8, 23, 10),
        data: { id: 'asset-1' },
        attemptsMade: 1,
        account: { id: 'user-1', name: 'Ada Lovelace' },
        worker: { kind: QueueJobWorkerKind.FrameleafCloud, name: 'Studio cloud' },
      },
      {
        id: 'job-2',
        name: JobName.AssetDetectFaces,
        timestamp: Date.UTC(2026, 8, 23, 9),
        data: {},
        worker: { kind: QueueJobWorkerKind.Lan, name: 'Workshop GPU' },
      },
      {
        id: 'job-3',
        name: JobName.AssetDetectFaces,
        timestamp: Date.UTC(2026, 8, 23, 8),
        data: { id: 'asset-gone' },
        worker: { kind: QueueJobWorkerKind.Lan, name: 'Workshop GPU' },
      },
    ]);
    render(JobsManager);

    await screen.findAllByRole('button', { name: /^Detect faces/ });
    const table = screen.getByRole('table');
    expect(within(table).getByRole('columnheader', { name: 'Account' })).toBeInTheDocument();
    expect(within(table).getByRole('columnheader', { name: 'Computer' })).toBeInTheDocument();
    const [, first, second, third] = within(table).getAllByRole('row');
    expect(within(first).getByText('Ada Lovelace')).toBeInTheDocument();
    expect(within(first).getByText('Frameleaf Cloud').closest('span')).toHaveAttribute('title', 'Studio cloud');
    // A job that names no item covers the whole server; one whose item has no single owner has no account.
    expect(within(second).getByText('Server')).toBeInTheDocument();
    expect(within(third).getByText('No account')).toBeInTheDocument();
    expect(within(second).getByText('Local / LAN')).toBeInTheDocument();

    await fireEvent.click(within(first).getByRole('button', { name: /^Detect faces/ }));
    const detail = screen.getByRole('dialog', { name: 'Detect faces' });
    expect(within(detail).getByText('Account').nextElementSibling).toHaveTextContent('Ada Lovelace');
    expect(within(detail).getByText('Computer').nextElementSibling).toHaveTextContent('Frameleaf Cloud · Studio cloud');
  });

  it('retries the failed jobs after the review, without an acknowledgement', async () => {
    at('&queue=face-detection&tab=failed');
    vi.mocked(retryFailedQueueJobs).mockResolvedValue({ count: 3 });
    render(JobsManager);

    await fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    const review = screen.getByRole('dialog', { name: 'Try again' });
    expect(within(review).getByText(/Put failed jobs back in the queue/)).toBeInTheDocument();
    expect(within(review).getByText('3 items')).toBeInTheDocument();
    expect(within(review).queryByRole('checkbox')).not.toBeInTheDocument();
    await fireEvent.click(within(review).getByRole('button', { name: 'Try again' }));

    await waitFor(() => expect(retryFailedQueueJobs).toHaveBeenCalledWith({ name: QueueName.FaceDetection }));
    expect(await screen.findByText('Try again: request sent to the server.')).toBeInTheDocument();
  });

  it('offers no retry while no job has failed', () => {
    queues.list = [queue(QueueName.FaceDetection)];
    at('&queue=face-detection&tab=failed');
    render(JobsManager);

    expect(screen.getByRole('button', { name: 'Try again' })).toBeDisabled();
  });

  it("narrows the counts and the jobs to one account's items (JobsManager.jsx 341-355, 838-840)", async () => {
    // The account comes from the command center's "Viewing" scope (design review finding 65).
    at('&queue=face-detection&tab=failed&scope=account:grace');
    vi.mocked(getQueueOwnerStatistics).mockResolvedValue({
      active: 0,
      completed: 0,
      delayed: 0,
      failed: 1,
      paused: 0,
      waiting: 0,
      truncated: true,
    });
    render(JobsManager);

    await waitFor(() =>
      expect(getQueueOwnerStatistics).toHaveBeenCalledWith({ name: QueueName.FaceDetection, ownerId: 'grace' }),
    );
    expect(await screen.findByRole('tab', { name: /Failed\s*1/ })).toBeInTheDocument();
    expect(screen.getByText(/Counts and job details: Grace Hopper\./)).toBeInTheDocument();
    expect(screen.getByText(/newest 1,000 jobs of each state/)).toBeInTheDocument();
    await waitFor(() =>
      expect(getQueueJobs).toHaveBeenCalledWith({
        name: QueueName.FaceDetection,
        status: [QueueJobStatus.Failed],
        ownerId: 'grace',
      }),
    );
    expect(
      await screen.findByText('No matching jobs for Grace Hopper. Other accounts may still have work in this queue.'),
    ).toBeInTheDocument();
  });

  it("says nothing about the work, rather than 'nothing is running', while an account's counts load", async () => {
    vi.mocked(getQueueOwnerStatistics).mockReturnValue(new Promise(() => {}));
    at('&view=advanced&scope=account:grace');
    render(JobsManager);

    expect(screen.queryByRole('region', { name: 'Background work status' })).not.toBeInTheDocument();
    expect(screen.queryByText('Nothing is running')).not.toBeInTheDocument();
    expect(screen.queryByText('Nothing is running, waiting, paused or failed.')).not.toBeInTheDocument();
  });

  it("shows a dash, not 0, in one kind of work while an account's counts load", async () => {
    vi.mocked(getQueueOwnerStatistics).mockReturnValue(new Promise(() => {}));
    at('&queue=face-detection&scope=account:grace');
    render(JobsManager);

    const failed = screen.getByText('Failed', { selector: '.jm-metric span' }).nextElementSibling;
    expect(failed).toHaveTextContent('—');
    expect(screen.getByText('Failed', { selector: '.jm-metric span' }).closest('.jm-metrics')).toHaveAttribute(
      'aria-busy',
      'true',
    );
  });

  it("shows a queue's counts as unknown, not 0, when they cannot be read for an account", async () => {
    vi.mocked(getQueueOwnerStatistics).mockImplementation(({ name }) =>
      name === QueueName.FaceDetection
        ? Promise.reject(new Error('down'))
        : Promise.resolve({ active: 1, completed: 0, delayed: 0, failed: 0, paused: 0, waiting: 2, truncated: false }),
    );
    at('&view=advanced&scope=account:grace');
    render(JobsManager);

    expect(
      await screen.findByText('Some counts for Grace Hopper could not be loaded. They show as unknown.'),
    ).toBeInTheDocument();
    // What could be read is shown; the task that could not shows a dash, never 0.
    const faces = screen.getByRole('button', { name: 'Open Finding faces' }).closest('tr')!;
    expect(within(faces).getAllByText('—').length).toBeGreaterThan(0);
    const thumbnails = screen.getByRole('button', { name: 'Open Making thumbnails' }).closest('tr')!;
    expect(
      within(thumbnails)
        .getAllByRole('cell')
        .map((cell) => cell.textContent?.trim())
        .slice(1, 3),
    ).toEqual(['1', '2']);
  });

  it("lets a slow read of an account's counts land while the open queue keeps changing (FL-1239)", async () => {
    const reads: ((value: Awaited<ReturnType<typeof getQueueOwnerStatistics>>) => void)[] = [];
    vi.mocked(getQueueOwnerStatistics).mockImplementation(
      () =>
        new Promise((resolve) => {
          reads.push(resolve);
        }),
    );
    const counts = (failed: number) => ({
      active: 0,
      completed: 0,
      delayed: 0,
      failed,
      paused: 0,
      waiting: 0,
      truncated: false,
    });
    at('&queue=face-detection&tab=failed&scope=account:grace');
    render(JobsManager);
    await waitFor(() => expect(getQueueOwnerStatistics).toHaveBeenCalledTimes(1));

    // two polls with new counts while the first read is still out: no new read yet
    for (const waiting of [3, 4]) {
      queues.list = [queue(QueueName.FaceDetection, { waiting })];
      queues.changed();
      await tick();
    }
    expect(getQueueOwnerStatistics).toHaveBeenCalledTimes(1);

    // the first read lands and shows, then one more read follows for the changes meanwhile
    reads[0](counts(2));
    expect(await screen.findByRole('tab', { name: /Failed\s*2/ })).toBeInTheDocument();
    await waitFor(() => expect(getQueueOwnerStatistics).toHaveBeenCalledTimes(2));
    reads[1](counts(5));
    expect(await screen.findByRole('tab', { name: /Failed\s*5/ })).toBeInTheDocument();
    expect(getQueueOwnerStatistics).toHaveBeenCalledTimes(2);
  });

  it("reads an account's counts once the queues load, rather than showing 0 (FL-1239)", async () => {
    vi.mocked(getQueueOwnerStatistics).mockResolvedValue({
      active: 0,
      completed: 0,
      delayed: 0,
      failed: 4,
      paused: 0,
      waiting: 0,
      truncated: false,
    });
    queues.list = [];
    at('&view=advanced&scope=account:grace');
    render(JobsManager);
    await tick();
    expect(getQueueOwnerStatistics).not.toHaveBeenCalled();
    // Nothing read yet: a dash, not 0.
    expect(screen.getByText('Failed', { selector: '.jm-metric span' }).nextElementSibling).toHaveTextContent('—');

    queues.list = [queue(QueueName.ThumbnailGeneration), queue(QueueName.FaceDetection)];
    queues.changed();
    await waitFor(() => expect(getQueueOwnerStatistics).toHaveBeenCalledTimes(2));
    expect(getQueueOwnerStatistics).toHaveBeenCalledWith({ name: QueueName.FaceDetection, ownerId: 'grace' });
    await waitFor(() =>
      expect(screen.getByText('Failed', { selector: '.jm-metric span' }).nextElementSibling).toHaveTextContent('8'),
    );

    // A stats tick for the same queues does not read them again.
    queues.list = [queue(QueueName.ThumbnailGeneration, { waiting: 3 }), queue(QueueName.FaceDetection)];
    queues.changed();
    await tick();
    expect(getQueueOwnerStatistics).toHaveBeenCalledTimes(2);
  });
});

describe('Job manager on returning to the window', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reads the queues again, but not more than once every few seconds', async () => {
    const start = Date.now();
    const now = vi.spyOn(Date, 'now').mockReturnValue(start);
    render(JobsManager);
    vi.mocked(queueManager.refresh).mockClear();

    await fireEvent.focus(globalThis as never);
    expect(queueManager.refresh).not.toHaveBeenCalled();

    now.mockReturnValue(start + 6000);
    await fireEvent.focus(globalThis as never);
    await fireEvent(document, new Event('visibilitychange'));
    expect(queueManager.refresh).toHaveBeenCalledTimes(1);
  });
});

describe('Enrichment tasks (FL-59, JobsManager.jsx EnrichmentJobDialog)', () => {
  const openTasks = async () => {
    render(JobsManager);
    await fireEvent.click(screen.getByRole('button', { name: 'Enrichment tasks' }));
    return screen.getByRole('dialog', { name: 'Enrichment tasks' });
  };

  it('queues a description regeneration after its review, with the saved estimate', async () => {
    vi.mocked(triggerImageDescriptionRequeue).mockResolvedValue({ queued: true, cloudBatches: false });
    const dialog = await openTasks();

    expect(within(dialog).getByLabelText('Task')).toHaveValue('descriptions');
    expect(within(dialog).getByLabelText('When')).toHaveValue('now');
    expect(within(dialog).getByText('All accounts. Pending settings are not applied by this task.')).toBeVisible();
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Review task' }));

    const review = screen.getByRole('dialog', { name: 'Regenerate descriptions' });
    expect(await within(review).findByText(/120 eligible items · about 10 min/)).toBeInTheDocument();
    await fireEvent.click(within(review).getByRole('button', { name: 'Regenerate descriptions' }));

    await waitFor(() => expect(triggerImageDescriptionRequeue).toHaveBeenCalled());
    expect(await screen.findByText('Regenerate descriptions: request sent to the server.')).toBeInTheDocument();
  });

  it('says descriptions routed to Frameleaf Cloud go through batches instead of being queued (FL-163)', async () => {
    vi.mocked(triggerImageDescriptionRequeue).mockResolvedValue({ queued: false, cloudBatches: true });
    const dialog = await openTasks();

    await fireEvent.click(within(dialog).getByRole('button', { name: 'Review task' }));
    const review = screen.getByRole('dialog', { name: 'Regenerate descriptions' });
    await within(review).findByText(/120 eligible items/);
    await fireEvent.click(within(review).getByRole('button', { name: 'Regenerate descriptions' }));

    expect(
      await screen.findByText(
        'Descriptions go to Frameleaf Cloud, which describes photos in batches. Describe them from Frameleaf Cloud processing, where the estimate comes first.',
      ),
    ).toBeInTheDocument();
  });

  it('keeps a reminder instead of queueing, and offers it again from the page', async () => {
    vi.mocked(deferImageDescriptionRequeue).mockResolvedValue(undefined as never);
    const dialog = await openTasks();

    await fireEvent.change(within(dialog).getByLabelText('When'), { target: { value: 'later' } });
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Review task' }));
    const review = screen.getByRole('dialog', { name: 'Remind me to regenerate descriptions' });
    await fireEvent.click(within(review).getByRole('button', { name: 'Remind me to regenerate descriptions' }));

    await waitFor(() => expect(deferImageDescriptionRequeue).toHaveBeenCalled());
    expect(triggerImageDescriptionRequeue).not.toHaveBeenCalled();
    expect(await screen.findByText('Description regeneration is waiting for your review.')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Review reminder' }));
    expect(screen.getByRole('dialog', { name: 'Enrichment tasks' })).toBeVisible();
  });

  it('refuses to queue descriptions while description work is already waiting', async () => {
    queues.list = [...queues.list, queue(QueueName.ImageDescription, { waiting: 4 })];
    const dialog = await openTasks();

    await fireEvent.click(within(dialog).getByRole('button', { name: 'Review task' }));
    const review = screen.getByRole('dialog', { name: 'Regenerate descriptions' });

    expect(within(review).getByRole('alert')).toHaveTextContent('Description work is already active or waiting.');
    expect(within(review).getByRole('button', { name: 'Regenerate descriptions' })).toBeDisabled();
  });

  it('re-evaluates one smart-album category after its review', async () => {
    vi.mocked(triggerSmartAlbumReevaluate).mockResolvedValue({ queued: true } as never);
    const dialog = await openTasks();

    await fireEvent.change(within(dialog).getByLabelText('Task'), { target: { value: 'smart-albums' } });
    await fireEvent.change(within(dialog).getByLabelText('Categories'), {
      target: { value: SmartAlbumBuiltInKind.Food },
    });
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Review task' }));
    const review = screen.getByRole('dialog', { name: 'Re-evaluate smart albums' });
    await fireEvent.click(within(review).getByRole('button', { name: 'Re-evaluate smart albums' }));

    await waitFor(() =>
      expect(triggerSmartAlbumReevaluate).toHaveBeenCalledWith({
        smartAlbumReevaluateRequestDto: { kind: SmartAlbumBuiltInKind.Food },
      }),
    );
  });

  it('cannot add a hardware preset without the settings draft', async () => {
    const dialog = await openTasks();

    await fireEvent.change(within(dialog).getByLabelText('Task'), { target: { value: 'hardware' } });

    expect(within(dialog).getByLabelText('Acceleration')).toHaveValue('auto');
    expect(within(dialog).getByRole('button', { name: 'Add preset to settings review' })).toBeDisabled();
  });
});

describe('Background work › Everyday (approved design, 2026-11-04)', () => {
  it('opens on Everyday: status with Pause all and Resume, pace, when heavy work runs and the eight features', () => {
    at('');
    render(JobsManager);

    expect(screen.getByRole('button', { name: 'Everyday', pressed: true })).toBeInTheDocument();
    const status = within(screen.getByRole('region', { name: 'Background work status' }));
    expect(status.getByRole('heading', { name: '3 things failed' })).toBeInTheDocument();
    expect(status.getByRole('button', { name: 'Pause everything' })).toBeInTheDocument();
    expect(status.getByRole('button', { name: 'Resume' })).toBeInTheDocument();
    expect(status.getByRole('link', { name: 'See the failed task' })).toHaveAttribute(
      'href',
      expect.stringContaining('queue=face-detection&tab=failed'),
    );
    expect(status.getByRole('link', { name: /Fix in Activity/ })).toHaveAttribute('href', '/activity');
    for (const name of [
      'Ready to browse',
      'Faces & identity',
      'Visual search',
      'Text, documents & receipts',
      'Descriptions & tags',
      'Transcripts & captions',
      'Studio export',
      'Upkeep',
    ]) {
      expect(screen.getByRole('button', { name: `More for ${name}` })).toBeInTheDocument();
    }
    // Faces has a failed task; Text is paused.
    expect(screen.getAllByText('Needs a look').length).toBeGreaterThan(0);
  });

  it('pauses one feature’s tasks after one review', async () => {
    at('');
    render(JobsManager);

    await fireEvent.click(screen.getByRole('button', { name: 'More for Ready to browse' }));
    await fireEvent.click(await screen.findByRole('menuitem', { name: 'Pause' }));
    const dialog = await screen.findByRole('dialog', { name: 'Pause Ready to browse' });
    vi.mocked(updateQueue).mockResolvedValue(queue(QueueName.ThumbnailGeneration, {}, true));
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Pause Ready to browse' }));
    await waitFor(() =>
      expect(updateQueue).toHaveBeenCalledWith({
        name: QueueName.ThumbnailGeneration,
        queueUpdateDto: { isPaused: true },
      }),
    );
    // Only that feature's tasks.
    expect(updateQueue).not.toHaveBeenCalledWith(expect.objectContaining({ name: QueueName.FaceDetection }));
  });

  it('counts everything as paused when only the task that cannot pause still runs (FL-1238)', async () => {
    queues.list = [
      queue(QueueName.ThumbnailGeneration, { waiting: 2 }, true),
      queue(QueueName.StorageTemplateMigration, {}, true),
      queue(QueueName.BackgroundTask, { active: 1 }),
    ];
    at('');
    render(JobsManager);

    const status = within(screen.getByRole('region', { name: 'Background work status' }));
    expect(status.getByRole('heading', { name: 'Background work is paused' })).toBeInTheDocument();
    expect(status.queryByRole('button', { name: 'Pause everything' })).not.toBeInTheDocument();
    // Upkeep holds the background task, which never pauses: its menu offers Resume, not Pause.
    await fireEvent.click(screen.getByRole('button', { name: 'More for Upkeep' }));
    expect(await screen.findByRole('menuitem', { name: 'Resume' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Pause' })).not.toBeInTheDocument();
  });

  it('warns about face results before doing Faces all again, as one task’s redo does (FL-1253)', async () => {
    queues.list = [queue(QueueName.FaceDetection), queue(QueueName.FacialRecognition)];
    at('');
    render(JobsManager);

    await fireEvent.click(screen.getByRole('button', { name: 'More for Faces & identity' }));
    await fireEvent.click(await screen.findByRole('menuitem', { name: 'Do it all again…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Do Faces & identity all again' });
    expect(within(dialog).getByText(en.frameleaf_jobs_review_force_faces)).toBeInTheDocument();
    expect(within(dialog).queryByText(en.frameleaf_bgwork_feature_review_force_detail)).not.toBeInTheDocument();
  });

  it('opens Advanced at one feature’s tasks from its menu', async () => {
    at('');
    render(JobsManager);

    await fireEvent.click(screen.getByRole('button', { name: 'More for Faces & identity' }));
    await fireEvent.click(await screen.findByRole('menuitem', { name: /See its .*tasks? in Advanced/ }));
    await waitFor(() =>
      expect(goto).toHaveBeenCalledWith(expect.stringContaining('view=advanced&feature=faces'), expect.anything()),
    );
  });
});

describe('One job at a time (approved design, 2026-11-04)', () => {
  const failedJob = {
    id: '6f1d7c6e-2b0f-4c55-9b0e-6b8f2c1c1a01',
    name: JobName.AssetDetectFaces,
    timestamp: Date.UTC(2026, 8, 23, 10),
    data: { id: 'asset-1' },
    failedReason: 'Machine learning is unreachable',
    worker: { kind: QueueJobWorkerKind.Server, name: null },
  };

  it('retries one failed job from its row', async () => {
    at('&queue=face-detection&tab=failed');
    vi.mocked(getQueueJobs).mockResolvedValue([failedJob]);
    vi.mocked(retryQueueJob).mockResolvedValue(undefined as never);
    render(JobsManager);

    await fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    await waitFor(() =>
      expect(retryQueueJob).toHaveBeenCalledWith({ name: QueueName.FaceDetection, id: failedJob.id }),
    );
    expect(await screen.findByText('Detect faces is back in the queue.')).toBeInTheDocument();
  });

  describe('a failed job for a photo with a file problem', () => {
    const openDetail = async () => {
      at('&queue=face-detection&tab=failed');
      vi.mocked(getQueueJobs).mockResolvedValue([failedJob]);
      render(JobsManager);
      await fireEvent.click(await screen.findByRole('button', { name: /Machine learning is unreachable/ }));
      return screen.findByRole('dialog');
    };

    it('a failed job for a photo with a file problem links to Library care', async () => {
      vi.mocked(getAssetInfo).mockResolvedValue({ id: 'asset-1', fileProblem: { findingId: 'finding-1', missing: false } } as never);
      const dialog = await openDetail();

      const link = await within(dialog).findByRole('link', { name: 'In Library care' });
      expect(getAssetInfo).toHaveBeenCalledWith({ id: 'asset-1' });
      expect(link).toHaveAttribute('href', expect.stringContaining('area=care'));
      expect(link).toHaveAttribute('href', expect.stringContaining('section=files'));
      expect(link).toHaveAttribute('href', expect.stringContaining('file=finding-1'));
    });

    it('shows no link when the photo has no file problem', async () => {
      vi.mocked(getAssetInfo).mockResolvedValue({ id: 'asset-1', fileProblem: null } as never);
      const dialog = await openDetail();

      await waitFor(() => expect(getAssetInfo).toHaveBeenCalled());
      expect(within(dialog).queryByRole('link', { name: 'In Library care' })).not.toBeInTheDocument();
    });

    it('does not look anything up when the job has no photo id', async () => {
      at('&queue=face-detection&tab=failed');
      vi.mocked(getQueueJobs).mockResolvedValue([{ ...failedJob, data: { id: 42 } }]);
      render(JobsManager);
      await fireEvent.click(await screen.findByRole('button', { name: /Machine learning is unreachable/ }));
      await screen.findByRole('dialog');

      expect(getAssetInfo).not.toHaveBeenCalled();
    });

    it('shows nothing extra when the lookup fails', async () => {
      vi.mocked(getAssetInfo).mockRejectedValue(new Error('403'));
      const dialog = await openDetail();

      await waitFor(() => expect(getAssetInfo).toHaveBeenCalled());
      expect(within(dialog).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
      expect(within(dialog).queryByRole('link', { name: 'In Library care' })).not.toBeInTheDocument();
    });
  });

  it('starts one waiting job now', async () => {
    at('&queue=thumbnail-generation&tab=waiting');
    vi.mocked(getQueueJobs).mockResolvedValue([
      { ...failedJob, name: JobName.AssetGenerateThumbnails, failedReason: undefined },
    ]);
    vi.mocked(startQueueJob).mockResolvedValue(undefined as never);
    render(JobsManager);

    // The Waiting tab lists waiting, delayed and paused jobs (the mock answers each with this one).
    const [start] = await screen.findAllByRole('button', { name: 'Start now' });
    await fireEvent.click(start);
    await waitFor(() =>
      expect(startQueueJob).toHaveBeenCalledWith({ name: QueueName.ThumbnailGeneration, id: failedJob.id }),
    );
  });

  it('shows Run on one item disabled, with the reason, for a task the server cannot run on one item yet', () => {
    queues.list = [queue(QueueName.Sidecar)];
    at('&queue=sidecar');
    render(JobsManager);

    const button = screen.getByRole('button', { name: 'Run on one item…' });
    expect(button).toBeDisabled();
    expect(button.closest('span')).toHaveAttribute('title', 'This task can’t run on one item yet.');
  });

  it('lists photos only for Locked content, which the server reads for photos alone (FL-1249)', async () => {
    queues.list = [queue(QueueName.NsfwDetection)];
    at('&queue=nsfw-detection');
    render(JobsManager);

    await fireEvent.click(screen.getByRole('button', { name: 'Run on one item…' }));
    await screen.findByRole('dialog', { name: 'Run on one item' });
    await waitFor(() =>
      expect(searchAssets).toHaveBeenCalledWith({
        metadataSearchDto: expect.objectContaining({ type: AssetTypeEnum.Image }),
      }),
    );
  });

  it('runs a task on one item picked from the library', async () => {
    at('&queue=thumbnail-generation');
    vi.mocked(runQueueOnOne).mockResolvedValue(undefined as never);
    render(JobsManager);

    await fireEvent.click(screen.getByRole('button', { name: 'Run on one item…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Run on one item' });
    await fireEvent.click(await within(dialog).findByRole('radio', { name: /IMG_7.jpg/ }));
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Start now IMG_7.jpg' }));
    await waitFor(() =>
      expect(runQueueOnOne).toHaveBeenCalledWith({
        name: QueueName.ThumbnailGeneration,
        queueRunOneDto: { assetId: '9a1d7c6e-2b0f-4c55-9b0e-6b8f2c1c1a02' },
      }),
    );
  });
});
