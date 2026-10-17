import {
  createJob,
  deferImageDescriptionRequeue,
  emptyQueue,
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
  runQueueCommandLegacy,
  searchUsersAdmin,
  SmartAlbumBuiltInKind,
  triggerImageDescriptionRequeue,
  triggerSmartAlbumReevaluate,
  updateQueue,
  type QueueResponseDto,
} from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import JobsManager from '$lib/components/frameleaf/JobsManager.svelte';
import { queueManager } from '$lib/managers/queue-manager.svelte';
import en from '../../../../../i18n/en.json';

const state = vi.hoisted(() => ({ url: new URL('https://example.test/user-settings?area=processing&section=queues') }));
const queues = vi.hoisted(() => ({ list: [] as QueueResponseDto[] }));

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
  runQueueCommandLegacy: vi.fn(),
  updateQueue: vi.fn(),
  emptyQueue: vi.fn(),
  getQueue: vi.fn(),
  createJob: vi.fn(),
  retryFailedQueueJobs: vi.fn(),
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
vi.mock('$lib/managers/queue-manager.svelte', () => ({
  queueManager: {
    get queues() {
      return queues.list;
    },
    // One answer from the server: the page is past its first load.
    snapshots: [{ timestamp: 0, snapshot: [] }],
    listen: () => () => {},
    refresh: vi.fn(),
  },
}));
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
  at('');
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
  it('opens on one sentence, then only the work that is running, waiting, paused or failed (FL-364)', () => {
    render(JobsManager);

    // The page's heading is the settings host's; the first thing here is the answer.
    const status = within(screen.getByRole('region', { name: 'Background work status' }));
    expect(status.getByRole('heading', { name: '3 things failed' })).toBeInTheDocument();
    expect(status.getByText('Finding faces: 3 failed. Your original files are untouched.')).toBeInTheDocument();
    expect(status.getByRole('link', { name: 'Review what failed in Finding faces' })).toHaveAttribute(
      'href',
      expect.stringContaining('queue=face-detection&tab=failed'),
    );
    expect(status.getByRole('button', { name: 'Resume' })).toBeInTheDocument();

    const now = within(screen.getByRole('region', { name: 'Now' }));
    const listed = now.getAllByRole('listitem').slice(0, 4);
    expect(listed.map((item) => item.querySelector('strong')?.textContent)).toEqual([
      'Making thumbnails',
      'Finding faces',
      'Housekeeping',
      'Reading text in photos',
    ]);
    expect(within(listed[0]).getByText('Running')).toBeInTheDocument();
    expect(within(listed[0]).getByText('7 left')).toBeInTheDocument();
    expect(within(listed[1]).getByText('3 failed')).toBeInTheDocument();
    expect(within(listed[3]).getByText('Paused')).toBeInTheDocument();
    // The old table's columns and the three header buttons are gone.
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    for (const label of ['Concurrency', 'Enrichment tasks', 'Create job']) {
      expect(screen.queryByRole('button', { name: label })).not.toBeInTheDocument();
    }
  });

  it('keeps every kind of work behind "Show all", in plain names and groups', () => {
    render(JobsManager);

    const all = screen.getByText('Show all 4 kinds of work').closest('details')!;
    expect(all).not.toHaveAttribute('open');
    for (const group of ['Photos and videos', 'AI features', 'Behind the scenes']) {
      expect(within(all).getByRole('heading', { name: group })).toBeInTheDocument();
    }
    expect(within(all).getByRole('link', { name: 'Manage Reading text in photos' })).toHaveAttribute(
      'href',
      expect.stringContaining('queue=ocr'),
    );
    expect(
      within(all).getByText('Shows work for everyone on this server. Pausing affects everyone.'),
    ).toBeInTheDocument();
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

    expect(screen.getByRole('button', { name: 'All background work' })).toBeInTheDocument();
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

    expect(screen.getByRole('heading', { level: 1, name: 'Finding faces' })).toBeInTheDocument();
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

    await fireEvent.click(screen.getByRole('button', { name: 'More tasks' }));
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
    ]);
    render(JobsManager);

    await screen.findAllByRole('button', { name: /^Detect faces/ });
    const table = screen.getByRole('table');
    expect(within(table).getByRole('columnheader', { name: 'Account' })).toBeInTheDocument();
    expect(within(table).getByRole('columnheader', { name: 'Worker' })).toBeInTheDocument();
    const [, first, second] = within(table).getAllByRole('row');
    expect(within(first).getByText('Ada Lovelace')).toBeInTheDocument();
    expect(within(first).getByText('Frameleaf Cloud').closest('span')).toHaveAttribute('title', 'Studio cloud');
    expect(within(second).getByText('No account')).toBeInTheDocument();
    expect(within(second).getByText('Local / LAN')).toBeInTheDocument();

    await fireEvent.click(within(first).getByRole('button', { name: /^Detect faces/ }));
    const detail = screen.getByRole('dialog', { name: 'Detect faces' });
    expect(within(detail).getByText('Account').nextElementSibling).toHaveTextContent('Ada Lovelace');
    expect(within(detail).getByText('Worker').nextElementSibling).toHaveTextContent('Frameleaf Cloud · Studio cloud');
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
    at('&scope=account:grace');
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
    at('&scope=account:grace');
    render(JobsManager);

    expect(
      await screen.findByText('Some counts for Grace Hopper could not be loaded. They show as unknown.'),
    ).toBeInTheDocument();
    // What could be read is shown; the kind that could not is never called up to date.
    const now = within(screen.getByRole('region', { name: 'Now' }));
    expect(now.getByText('Counts are for Grace Hopper.', { exact: false })).toBeInTheDocument();
    const faces = now.getByRole('link', { name: 'Manage Finding faces' }).closest('li')!;
    expect(within(faces).getByText('Couldn’t be read')).toBeInTheDocument();
    expect(within(faces).queryByText('Up to date')).not.toBeInTheDocument();
    const thumbnails = now.getAllByRole('link', { name: 'Manage Making thumbnails' }).at(-1)!.closest('li')!;
    expect(within(thumbnails).getByText('Running · 3 left')).toBeInTheDocument();
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
    await fireEvent.click(screen.getByRole('button', { name: /^Redo descriptions/ }));
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
