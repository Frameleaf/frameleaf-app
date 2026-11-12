import {
  QueueIdleReason,
  QueueName,
  QueueProblemAction,
  QueueProblemCause,
  QueueProblemUnit,
  type QueueOverviewResponseDto,
  type QueueProblemDto,
  type QueueResponseDto,
  type QueueTaskDto,
} from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import en from '$i18n/en.json';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import JobsAdvancedList from '$lib/components/frameleaf/jobs/JobsAdvancedList.svelte';
import { JOB_QUEUES } from '$lib/frameleaf/job-queues';

const TITLES: Partial<Record<QueueName, string>> = {
  [QueueName.VideoConversion]: 'Converting videos',
  [QueueName.FaceDetection]: 'Finding faces',
  [QueueName.FacialRecognition]: 'Recognising people',
  [QueueName.SmartSearch]: 'Preparing photos for search',
  [QueueName.StorageTemplateMigration]: 'Sort originals into folders',
  [QueueName.MetadataExtraction]: 'Reading photo details',
  [QueueName.ThumbnailGeneration]: 'Making thumbnails',
  [QueueName.BackgroundTask]: 'Housekeeping',
  [QueueName.Ocr]: 'Reading text in photos',
  [QueueName.Library]: 'Library scans',
};
const row = (name: QueueName, statistics: Partial<QueueResponseDto['statistics']> = {}, isPaused = false) => ({
  definition: JOB_QUEUES.find((queue) => queue.name === name)!,
  queue: {
    name,
    isPaused,
    hasUnfinishedWork: false,
    statistics: { active: 0, completed: 0, failed: 0, delayed: 0, waiting: 0, paused: 0, ...statistics },
  } as QueueResponseDto,
});
const problem = (cause: QueueProblemCause, count: number, more: Partial<QueueProblemDto> = {}): QueueProblemDto => ({
  cause,
  count,
  unit: QueueProblemUnit.Photos,
  queues: [QueueName.FaceDetection],
  message: null,
  ...more,
});
const overview = (problems: QueueProblemDto[] = [], tasks: QueueTaskDto[] = []): QueueOverviewResponseDto => ({
  problems,
  tasks,
});
const handlers = () => ({
  onOpen: vi.fn(),
  onCommand: vi.fn(),
  onPauseAll: vi.fn(),
  onResumeAll: vi.fn(),
  onConcurrency: vi.fn(),
  onEnrichment: vi.fn(),
  onCreate: vi.fn(),
  onChanged: vi.fn(),
});
const show = (
  rows: ReturnType<typeof row>[],
  props: Partial<ReturnType<typeof handlers>> & { refreshToken?: unknown } = {},
) => {
  const all = { ...handlers(), ...props };
  render(JobsAdvancedList, {
    rows,
    refreshToken: 0,
    title: (definition) => TITLES[definition.name] ?? definition.name,
    featureName: () => 'Ready to browse',
    workersOf: () => 3,
    careHref: '/care',
    activityHref: '/activity',
    ...all,
  });
  return all;
};
const taskRow = (name: string) => within(screen.getByText(name, { selector: '.ja-task-name' }).closest('li')!);
const problemRow = (heading: string) =>
  within(screen.getByRole('heading', { level: 4, name: new RegExp(heading) }).closest('li')!);

beforeAll(async () => {
  register('en', () => Promise.resolve(en));
  await init({ fallbackLocale: 'en', initialLocale: 'en' });
  await waitLocale();
});
beforeEach(() => {
  vi.clearAllMocks();
  sdkMock.getQueueOverview.mockResolvedValue(overview());
});

describe('Needs a look (FL-1486)', () => {
  const seven = [
    problem(QueueProblemCause.MlUnavailable, 80_909, {
      queues: [QueueName.FacialRecognition, QueueName.FaceDetection],
      message: 'Machine learning request to http://ml:3003 failed with status 503: Service Unavailable',
    }),
    problem(QueueProblemCause.Missing, 23_500, { queues: [QueueName.MetadataExtraction] }),
    problem(QueueProblemCause.TooLong, 7348, { unit: QueueProblemUnit.Videos, queues: [QueueName.VideoConversion] }),
    problem(QueueProblemCause.Damaged, 5256),
    problem(QueueProblemCause.Unsupported, 428, { queues: [QueueName.ThumbnailGeneration] }),
    problem(QueueProblemCause.WriteDenied, 176),
    problem(QueueProblemCause.Other, 415, {
      unit: QueueProblemUnit.Jobs,
      queues: [QueueName.BackgroundTask],
      message: 'duplicate key value violates unique constraint "session_token_uq"',
    }),
  ];

  it('shows the three biggest reasons, most photos first, and folds the rest', async () => {
    sdkMock.getQueueOverview.mockResolvedValue(overview(seven));
    show([row(QueueName.FaceDetection, { failed: 3 }), row(QueueName.FacialRecognition, { failed: 9 })]);

    await screen.findByText('The face and search helper didn’t answer');
    const headings = screen.getAllByRole('heading', { level: 4 }).map((heading) => heading.textContent?.trim());
    expect(headings).toEqual([
      expect.stringContaining('The face and search helper didn’t answer'),
      expect.stringContaining('The original file is missing'),
      expect.stringContaining('It took too long'),
    ]);
    expect(problemRow('The face and search helper').getByText('80,909 photos')).toBeInTheDocument();
    expect(problemRow('It took too long').getByText('7,348 videos')).toBeInTheDocument();
    expect(
      problemRow('The face and search helper').getByText(/In Recognising people, Finding faces/),
    ).toBeInTheDocument();
    // the summary counts everything that needs a look, folded or not
    expect(screen.getByText('118,032 need a look')).toBeInTheDocument();

    const fold = screen.getByRole('button', { name: '4 more reasons, 6,275 items' });
    expect(fold).toHaveAttribute('aria-expanded', 'false');
    await fireEvent.click(fold);
    expect(screen.getAllByRole('heading', { level: 4 })).toHaveLength(7);
    // files that can't be opened are files, not photos
    expect(problemRow('A kind of file').getByText('428 files')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Show the three biggest only' }));
    expect(screen.getAllByRole('heading', { level: 4 })).toHaveLength(3);
  });

  it('gives each reason its one action, the first one primary', async () => {
    sdkMock.getQueueOverview.mockResolvedValue(overview(seven));
    const { onOpen } = show([row(QueueName.FaceDetection, { failed: 3 })]);
    await screen.findByText('The face and search helper didn’t answer');
    await fireEvent.click(screen.getByRole('button', { name: /more reasons/ }));

    const action = (heading: string, name: string) => problemRow(heading).getByRole('button', { name });
    expect(action('The face and search helper', 'Try again')).toHaveClass('primary');
    expect(action('It took too long', 'Try again')).not.toHaveClass('primary');
    expect(action('A folder couldn’t be written to', 'Try again')).toBeInTheDocument();
    expect(action('A kind of file', 'Stop trying')).toBeInTheDocument();
    for (const heading of ['The original file is missing', 'The file is damaged']) {
      expect(problemRow(heading).getByRole('link', { name: 'Open Library care' })).toHaveAttribute('href', '/care');
    }
    await fireEvent.click(action('Something else', 'See the jobs'));
    expect(onOpen).toHaveBeenCalledWith(QueueName.BackgroundTask, 'failed');
    expect(sdkMock.actOnQueueProblem).not.toHaveBeenCalled();
  });

  it('shows the server’s words on request, and at once for a problem it did not recognise', async () => {
    sdkMock.getQueueOverview.mockResolvedValue(overview([seven[0], seven[6]]));
    show([row(QueueName.FaceDetection, { failed: 3 })]);
    await screen.findByText('Something else');

    expect(screen.getByText(/duplicate key value/)).toBeInTheDocument();
    expect(problemRow('Something else').queryByRole('button', { name: /What the server said/ })).toBeNull();
    expect(screen.queryByText(/status 503/)).toBeNull();
    const toggle = problemRow('The face and search helper').getByRole('button', { name: 'What the server said' });
    await fireEvent.click(toggle);
    expect(screen.getByText(/status 503/)).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Hide what the server said' }));
    expect(screen.queryByText(/status 503/)).toBeNull();
  });

  it('offers no toggle when no message may be shown', async () => {
    sdkMock.getQueueOverview.mockResolvedValue(overview([problem(QueueProblemCause.Unsupported, 2)]));
    show([row(QueueName.FaceDetection, { failed: 2 })]);
    await screen.findByText('A kind of file Frameleaf can’t open');
    expect(screen.queryByRole('button', { name: 'What the server said' })).toBeNull();
  });

  it('Try again puts the jobs back and says so in place', async () => {
    sdkMock.getQueueOverview.mockResolvedValue(overview([seven[0], seven[2]]));
    sdkMock.actOnQueueProblem.mockResolvedValue({ count: 80_909 });
    const { onChanged } = show([row(QueueName.FacialRecognition, { failed: 9 }, true), row(QueueName.FaceDetection)]);
    await screen.findByText('The face and search helper didn’t answer');

    await fireEvent.click(problemRow('The face and search helper').getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
    expect(sdkMock.actOnQueueProblem).toHaveBeenCalledWith({
      queueProblemActionDto: { cause: QueueProblemCause.MlUnavailable, action: QueueProblemAction.Retry },
    });
    const settled = problemRow('The face and search helper');
    expect(settled.getByText('Queued again. They run when Recognising people is resumed.')).toBeInTheDocument();
    expect(settled.queryByRole('button')).toBeNull();
    // what is settled no longer needs a look, and the next reason takes the primary action
    expect(screen.getByText('7,348 need a look')).toBeInTheDocument();
    expect(problemRow('It took too long').getByRole('button', { name: 'Try again' })).toHaveClass('primary');
  });

  it('Stop trying stops the files and says they no longer count', async () => {
    sdkMock.getQueueOverview.mockResolvedValue(overview([seven[4]]));
    sdkMock.actOnQueueProblem.mockResolvedValue({ count: 428 });
    show([row(QueueName.ThumbnailGeneration, { failed: 428 })]);
    await screen.findByText('A kind of file Frameleaf can’t open');

    await fireEvent.click(screen.getByRole('button', { name: 'Stop trying' }));
    expect(await screen.findByText('Left as they are. They no longer count as failed.')).toBeInTheDocument();
    expect(sdkMock.actOnQueueProblem).toHaveBeenCalledWith({
      queueProblemActionDto: { cause: QueueProblemCause.Unsupported, action: QueueProblemAction.Stop },
    });
  });

  it('says so when the action fails, and keeps the reason', async () => {
    sdkMock.getQueueOverview.mockResolvedValue(overview([seven[2]]));
    sdkMock.actOnQueueProblem.mockRejectedValue(new Error('offline'));
    const { onChanged } = show([row(QueueName.VideoConversion, { failed: 7348 })]);
    await screen.findByText('It took too long');

    await fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That didn’t work. Try again in a moment.');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('says nothing has failed when nothing has', async () => {
    show([row(QueueName.Library)]);
    expect(await screen.findByText('Nothing has failed.')).toBeInTheDocument();
    expect(screen.getByText('0 need a look')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 4 })).toBeNull();
  });

  it('offers to read again when the overview cannot be read', async () => {
    sdkMock.getQueueOverview.mockRejectedValueOnce(new Error('offline'));
    show([row(QueueName.Library)]);
    await fireEvent.click(await screen.findByRole('button', { name: /try again|retry/i }));
    expect(await screen.findByText('Nothing has failed.')).toBeInTheDocument();
    expect(sdkMock.getQueueOverview).toHaveBeenCalledTimes(2);
  });
});

describe('Tasks with work (FL-1486)', () => {
  const task = (name: QueueName, more: Partial<QueueTaskDto> = {}): QueueTaskDto => ({ name, reason: null, ...more });

  it('says why each task is not running and offers the one button for it', async () => {
    sdkMock.getQueueOverview.mockResolvedValue(
      overview(
        [],
        [
          task(QueueName.FacialRecognition, { reason: QueueIdleReason.Paused, pausedAt: '2026-11-10T15:00:00.000Z' }),
          task(QueueName.SmartSearch, {
            reason: QueueIdleReason.QuietHours,
            closedUntil: new Date(Date.now() + 3 * 3_600_000).toISOString(),
          }),
          task(QueueName.StorageTemplateMigration, {
            reason: QueueIdleReason.WaitingFor,
            waitingFor: QueueName.MetadataExtraction,
          }),
          task(QueueName.Ocr, { reason: QueueIdleReason.FeatureOff }),
        ],
      ),
    );
    const rows = [
      row(QueueName.VideoConversion, { active: 5, waiting: 142_922, failed: 7348 }),
      row(QueueName.FacialRecognition, { paused: 150_983, failed: 78_111 }, true),
      row(QueueName.SmartSearch, { paused: 1_359_793 }),
      row(QueueName.StorageTemplateMigration, { waiting: 550_350, failed: 39 }),
      row(QueueName.MetadataExtraction, { waiting: 12 }),
      row(QueueName.ThumbnailGeneration, { failed: 6928 }),
      row(QueueName.Ocr, { waiting: 4 }),
    ];
    const { onCommand } = show(rows);
    await screen.findByText(/You paused this on/);

    const running = taskRow('Converting videos');
    expect(running.getByText('Running 5 at once')).toBeInTheDocument();
    expect(running.getByText('142,922 waiting')).toBeInTheDocument();
    expect(running.getByText('7,348 failed')).toBeInTheDocument();
    await fireEvent.click(running.getByRole('button', { name: 'Pause Converting videos' }));
    expect(onCommand).toHaveBeenLastCalledWith('pause', rows[0]);

    // a pause someone made says since when, and its button resumes
    const paused = taskRow('Recognising people');
    expect(paused.getByText(/^You paused this on .*10/)).toBeInTheDocument();
    await fireEvent.click(paused.getByRole('button', { name: 'Resume Recognising people' }));
    expect(onCommand).toHaveBeenLastCalledWith('resume', rows[1]);

    // quiet hours are not a pause: the task says when it starts and can be started now
    const night = taskRow('Preparing photos for search');
    expect(night.getByText(/^Heavy work\. Starts tonight at /)).toBeInTheDocument();
    expect(night.queryByText(/paused/i)).toBeNull();
    await fireEvent.click(night.getByRole('button', { name: 'Start Preparing photos for search now' }));
    expect(onCommand).toHaveBeenLastCalledWith('resume', rows[2]);

    // nothing a person can do here: no button
    const after = taskRow('Sort originals into folders');
    expect(after.getByText('Waiting for Reading photo details to finish')).toBeInTheDocument();
    expect(after.queryByRole('button', { name: /^(Pause|Resume|Start) / })).toBeNull();
    const off = taskRow('Reading text in photos');
    expect(off.getByText('This feature is off')).toBeInTheDocument();
    expect(off.queryByRole('button', { name: /^(Pause|Resume|Start) / })).toBeNull();

    expect(taskRow('Reading photo details').getByText('Next in line')).toBeInTheDocument();
    const stopped = taskRow('Making thumbnails');
    expect(stopped.getByText('Only failures left')).toBeInTheDocument();
    expect(stopped.getByText('None waiting')).toBeInTheDocument();
  });

  it('a task paused a moment ago says Paused before the overview is read again', async () => {
    sdkMock.getQueueOverview.mockResolvedValue(overview([], [task(QueueName.FaceDetection)]));
    show([row(QueueName.FaceDetection, { paused: 10 }, true)]);
    const paused = taskRow('Finding faces');
    expect(await paused.findByText('Paused')).toBeInTheDocument();
    expect(paused.getByRole('button', { name: 'Resume Finding faces' })).toBeInTheDocument();
  });

  it('folds the tasks with nothing to do', async () => {
    show([row(QueueName.VideoConversion, { waiting: 2 }), row(QueueName.Library), row(QueueName.BackgroundTask)]);
    expect(screen.queryByText('Library scans')).toBeNull();
    const fold = screen.getByRole('button', { name: '2 tasks have nothing to do' });
    await fireEvent.click(fold);
    expect(taskRow('Library scans').getByText('Nothing to do')).toBeInTheDocument();
    // the background task can't be paused: it has no button
    expect(taskRow('Housekeeping').queryByRole('button', { name: /^Pause / })).toBeNull();
  });

  it('finds a task by its name or its feature', async () => {
    show([row(QueueName.VideoConversion, { waiting: 2 }), row(QueueName.FaceDetection, { waiting: 1 })]);
    const search = screen.getByRole('searchbox', { name: 'Search queues' });
    await fireEvent.input(search, { target: { value: 'faces' } });
    expect(screen.queryByText('Converting videos')).toBeNull();
    expect(screen.getByText('Finding faces')).toBeInTheDocument();
    await fireEvent.input(search, { target: { value: 'ready to browse' } });
    expect(screen.getByText('Converting videos')).toBeInTheDocument();
    await fireEvent.input(search, { target: { value: 'zzz' } });
    expect(screen.getByText('No task with work matches “zzz”.')).toBeInTheDocument();
  });

  it('opens a task from its row and its failures from nowhere else', async () => {
    const { onOpen, onConcurrency } = show([row(QueueName.VideoConversion, { waiting: 2 })]);
    await fireEvent.click(screen.getByRole('button', { name: 'Open Converting videos' }));
    expect(onOpen).toHaveBeenCalledWith(QueueName.VideoConversion);
    await fireEvent.click(screen.getByRole('button', { name: 'Converting videos: 3 at once' }));
    expect(onConcurrency).toHaveBeenCalledOnce();
  });
});

describe('the head and the foot (FL-1486)', () => {
  it('sums the work and offers Resume for what was paused, and Pause everything', async () => {
    const { onResumeAll, onPauseAll } = show([
      row(QueueName.VideoConversion, { active: 5, waiting: 10 }),
      row(QueueName.FaceDetection, { paused: 7 }, true),
      row(QueueName.FacialRecognition, {}, true),
    ]);
    expect(screen.getByText('5 running')).toBeInTheDocument();
    expect(screen.getByText('17 waiting')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Resume the 2 you paused' }));
    expect(onResumeAll).toHaveBeenCalledOnce();
    await fireEvent.click(screen.getByRole('button', { name: 'Pause everything' }));
    expect(onPauseAll).toHaveBeenCalledOnce();
  });

  it('keeps the tools at the foot and sends recent work to Activity', async () => {
    const { onConcurrency, onEnrichment, onCreate } = show([row(QueueName.VideoConversion)]);
    const tools = within(screen.getByRole('region', { name: 'Tools' }));
    await fireEvent.click(tools.getByRole('button', { name: 'How many run at once' }));
    await fireEvent.click(tools.getByRole('button', { name: 'Enrichment tasks' }));
    await fireEvent.click(tools.getByRole('button', { name: 'Create a job' }));
    expect(onConcurrency).toHaveBeenCalledOnce();
    expect(onEnrichment).toHaveBeenCalledOnce();
    expect(onCreate).toHaveBeenCalledOnce();
    expect(tools.getByRole('link', { name: 'Recent work is in Activity' })).toHaveAttribute('href', '/activity');
  });

  it('reads the overview again when its token changes', async () => {
    const { rerender } = render(JobsAdvancedList, {
      rows: [row(QueueName.VideoConversion)],
      refreshToken: 'a',
      title: (definition) => definition.name,
      featureName: () => '',
      workersOf: () => 1,
      careHref: '/care',
      activityHref: '/activity',
      ...handlers(),
    });
    await waitFor(() => expect(sdkMock.getQueueOverview).toHaveBeenCalledOnce());
    await rerender({ refreshToken: 'b' });
    await waitFor(() => expect(sdkMock.getQueueOverview).toHaveBeenCalledTimes(2));
  });
});
