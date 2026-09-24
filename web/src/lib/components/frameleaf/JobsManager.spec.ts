import {
  createJob,
  emptyQueue,
  getQueueJobs,
  ManualJobName,
  JobName,
  QueueCommand,
  QueueJobStatus,
  QueueName,
  runQueueCommandLegacy,
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
});

describe('Job manager (FL-71, JobsManager.jsx)', () => {
  it("shows the template's header, metrics and queue table on the server's queues", () => {
    render(JobsManager);

    expect(screen.getByText('PROCESSING')).toBeInTheDocument();
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
});
