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
} from '@immich/sdk';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import JobsManager from '$lib/components/frameleaf/JobsManager.svelte';
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
vi.mock('@immich/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@immich/sdk')>()),
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
    snapshots: [],
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
  it("shows the template's header, metrics and queue table on the server's queues", () => {
    render(JobsManager);

    expect(screen.getByText('Compute & jobs')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Queues & jobs' })).toBeInTheDocument();
    for (const label of ['Concurrency', 'Enrichment tasks', 'Create job', 'Resume 1 paused']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }

    const metrics = (label: string) =>
      screen.getByText(label, { selector: '.jm-metric span' }).nextElementSibling?.textContent;
    expect(metrics('Processing')).toBe('3');
    expect(metrics('Waiting & scheduled')).toBe('6');
    expect(metrics('Failed')).toBe('3');
    expect(metrics('Completed in activity')).toBe('40');

    const table = within(screen.getByRole('region', { name: 'Processing queues' }));
    expect(table.getByRole('button', { name: /^Thumbnails\s*Media$/ })).toBeInTheDocument();
    expect(table.getByRole('button', { name: /Text recognition\s*Intelligence · feature off/ })).toBeInTheDocument();
    expect(table.getByRole('button', { name: 'Resume Text recognition' })).toBeInTheDocument();
    // The server refuses to pause background tasks.
    expect(table.getByRole('button', { name: 'Pause Background tasks' })).toBeDisabled();
    expect(screen.getByText('4 of 4 queues')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open Library Care' })).toBeInTheDocument();
  });

  it('filters the queues by category', async () => {
    render(JobsManager);

    await fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'system' } });

    expect(screen.getByText('1 of 4 queues')).toBeInTheDocument();
  });

  it('pauses a queue after its review', async () => {
    vi.mocked(updateQueue).mockResolvedValue(queue(QueueName.ThumbnailGeneration, {}, true));
    render(JobsManager);

    await fireEvent.click(screen.getByRole('button', { name: 'Pause Thumbnails' }));
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

    expect(screen.getByRole('heading', { level: 1, name: 'Face detection' })).toBeInTheDocument();
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

    await fireEvent.click(screen.getByRole('button', { name: 'Remove failed records' }));
    const review = screen.getByRole('dialog', { name: 'Remove failed records' });
    const confirm = within(review).getByRole('button', { name: 'Remove failed records' });
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

    expect(screen.getByRole('button', { name: 'Run missing' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Refresh faces' })).toBeEnabled();
    await fireEvent.click(screen.getByRole('button', { name: 'Reset & reprocess' }));
    const review = screen.getByRole('dialog', { name: 'Reset & reprocess' });
    expect(within(review).getByText(/Reset generated face results/)).toBeInTheDocument();
    await fireEvent.click(within(review).getByRole('checkbox'));
    await fireEvent.click(within(review).getByRole('button', { name: 'Reset & reprocess' }));

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

    expect(screen.getByRole('button', { name: 'Run missing' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Clear waiting jobs' })).toBeEnabled();
  });

  it('states the server limit when more failed records exist than one removal clears', async () => {
    queues.list = [queue(QueueName.FaceDetection, { failed: 1500 })];
    at('&queue=face-detection&tab=failed');
    render(JobsManager);

    await fireEvent.click(screen.getByRole('button', { name: 'Remove failed records' }));
    const review = screen.getByRole('dialog', { name: 'Remove failed records' });
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
    expect(within(dialog).getByText('Background tasks · review required')).toBeInTheDocument();
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
    expect(within(history).getByText('Background tasks · 1 item · all accounts')).toBeInTheDocument();
  });

  it('sends queue commands only through the review and never offers pausing background tasks', async () => {
    queues.list = [queue(QueueName.BackgroundTask, { waiting: 2, failed: 1 })];
    at('&queue=background-task&tab=failed');
    render(JobsManager);

    expect(screen.getByRole('button', { name: 'Pause' })).toBeDisabled();
    await fireEvent.click(screen.getByRole('button', { name: 'Remove failed records' }));
    expect(screen.getByRole('dialog', { name: 'Remove failed records' })).toBeInTheDocument();
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

    await fireEvent.click(screen.getByRole('button', { name: 'Retry failed' }));
    const review = screen.getByRole('dialog', { name: 'Retry failed jobs' });
    expect(within(review).getByText(/Put failed jobs back in the queue/)).toBeInTheDocument();
    expect(within(review).getByText('3 items')).toBeInTheDocument();
    expect(within(review).queryByRole('checkbox')).not.toBeInTheDocument();
    await fireEvent.click(within(review).getByRole('button', { name: 'Retry failed jobs' }));

    await waitFor(() => expect(retryFailedQueueJobs).toHaveBeenCalledWith({ name: QueueName.FaceDetection }));
    expect(await screen.findByText('Retry failed jobs: request sent to the server.')).toBeInTheDocument();
  });

  it('offers no retry while no job has failed', () => {
    queues.list = [queue(QueueName.FaceDetection)];
    at('&queue=face-detection&tab=failed');
    render(JobsManager);

    expect(screen.getByRole('button', { name: 'Retry failed' })).toBeDisabled();
  });

  it("narrows the counts and the jobs to one account's items (JobsManager.jsx 341-355, 838-840)", async () => {
    at('&queue=face-detection&tab=failed');
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

    const filter = await screen.findByRole('combobox', { name: 'Account filter' });
    await screen.findByRole('option', { name: 'Grace Hopper' });
    await fireEvent.change(filter, { target: { value: 'grace' } });

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

  it("shows a dash, not 0, while an account's counts load", async () => {
    vi.mocked(getQueueOwnerStatistics).mockReturnValue(new Promise(() => {}));
    render(JobsManager);

    const filter = await screen.findByRole('combobox', { name: 'Account filter' });
    await screen.findByRole('option', { name: 'Grace Hopper' });
    await fireEvent.change(filter, { target: { value: 'grace' } });

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
    render(JobsManager);

    const filter = await screen.findByRole('combobox', { name: 'Account filter' });
    await screen.findByRole('option', { name: 'Grace Hopper' });
    await fireEvent.change(filter, { target: { value: 'grace' } });

    expect(
      await screen.findByText('Some counts for Grace Hopper could not be loaded. They show as unknown.'),
    ).toBeInTheDocument();
    const table = within(screen.getByRole('region', { name: 'Processing queues' }));
    const faces = table.getAllByRole('button', { name: /^Face detection/ })[0].closest('tr')!;
    expect(within(faces).getAllByText('—').length).toBeGreaterThan(0);
    const thumbnails = table.getAllByRole('button', { name: /^Thumbnails/ })[0].closest('tr')!;
    expect(within(thumbnails).getByText('2')).toBeInTheDocument();
    // The totals would be partial, so they are unknown too.
    expect(screen.getByText('Failed', { selector: '.jm-metric span' }).nextElementSibling).toHaveTextContent('—');
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
