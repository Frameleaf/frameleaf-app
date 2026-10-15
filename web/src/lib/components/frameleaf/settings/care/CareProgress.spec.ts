import { QueueCommand, QueueName, type AdminConfigDto, type QueueResponseDto } from '@frameleaf/sdk';
import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { SystemConfigDraftStore } from '$lib/frameleaf/system-config-draft.svelte';
import en from '../../../../../../../i18n/en.json';
import CareProgress from './CareProgress.svelte';

const draft = vi.hoisted(() => ({ store: undefined as unknown }));

vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('$lib/managers/feature-flags-manager.svelte', () => ({
  featureFlagsManager: {
    value: {
      configFile: false,
      smartSearch: true,
      facialRecognition: true,
      ocr: true,
      imageDescription: false,
      duplicateDetection: true,
    },
  },
}));
vi.mock('$lib/frameleaf/system-config-draft.svelte', async (original) => ({
  ...(await original<object>()),
  requireSystemConfigDraft: () => draft.store,
  getSystemConfigDraft: () => draft.store,
}));

const config = () =>
  ({
    libraryCare: {
      healthScan: true,
      healthScanCronExpression: '0 02 * * *',
      checksumScan: true,
      integrityAudit: true,
      livePhotoRepair: true,
      rawRecovery: true,
      duplicateReview: true,
      incrementalEnrichment: true,
      manualMetadata: true,
    },
  }) as unknown as AdminConfigDto;

const newStore = () => {
  const store = new SystemConfigDraftStore(
    { config: config(), revision: 'r1' },
    { defaults: config(), load: vi.fn(), save: vi.fn() },
  ) as SystemConfigDraftStore & { draft: AdminConfigDto };
  draft.store = store;
  return store;
};

const queue = (name: QueueName, waiting = 0, { isPaused = false, active = 0 } = {}) =>
  ({
    name,
    isPaused,
    hasUnfinishedWork: waiting + active > 0,
    statistics: { active, completed: 0, delayed: 0, failed: 0, paused: 0, waiting },
  }) as QueueResponseDto;

const hero = () => within(screen.getByRole('region', { name: 'Reading progress' }));
const row = (name: string) => within(screen.getByText(name, { selector: 'strong' }).closest('li')!);

describe('Search and recognition progress (FL-366)', () => {
  beforeAll(() => {
    addMessages('dev', en);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    sdkMock.getQueues.mockResolvedValue([]);
    sdkMock.getSummary.mockResolvedValue({ queues: { enrichmentPending: 0 } } as never);
  });

  it('says nothing is waiting when every queue is empty, and a feature that is off says so', async () => {
    newStore();
    render(CareProgress, { pollMs: 60_000 });

    expect(await hero().findByRole('heading', { name: 'Nothing is waiting to be read' })).toBeInTheDocument();
    expect(row('Visual search').getByText('Nothing waiting')).toBeInTheDocument();
    expect(row('Descriptions & tags').getByText('Off')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Finish now/ })).not.toBeInTheDocument();
  });

  it('counts what each feature still has to read', async () => {
    sdkMock.getQueues.mockResolvedValue([
      queue(QueueName.SmartSearch, 120),
      queue(QueueName.FaceDetection, 10, { active: 2 }),
    ]);
    newStore();
    render(CareProgress, { pollMs: 60_000 });

    expect(await hero().findByRole('heading', { name: 'Still reading 132 photos' })).toBeInTheDocument();
    expect(row('Visual search').getByText('120 to read')).toBeInTheDocument();
    expect(row('Faces & identity').getByText('12 to read')).toBeInTheDocument();
    expect(row('Faces & identity').getByText('Reading now')).toBeInTheDocument();
  });

  it('says when work is paused and "Finish now" resumes it the way the Job manager does', async () => {
    sdkMock.getQueues.mockResolvedValue([queue(QueueName.Ocr, 40, { isPaused: true })]);
    sdkMock.updateQueue.mockResolvedValue(queue(QueueName.Ocr, 40));
    newStore();
    render(CareProgress, { pollMs: 60_000 });

    expect(await hero().findByRole('heading', { name: 'Reading is paused' })).toBeInTheDocument();
    await fireEvent.click(hero().getByRole('button', { name: 'Finish now' }));
    expect(sdkMock.updateQueue).toHaveBeenCalledWith({ name: QueueName.Ocr, queueUpdateDto: { isPaused: false } });
  });

  it('queues the photo details still to read', async () => {
    sdkMock.getSummary.mockResolvedValue({ queues: { enrichmentPending: 7 } } as never);
    sdkMock.runQueueCommandLegacy.mockResolvedValue({} as never);
    newStore();
    render(CareProgress, { pollMs: 60_000 });

    expect(await hero().findByRole('heading', { name: 'Still reading 7 photos' })).toBeInTheDocument();
    await fireEvent.click(hero().getByRole('button', { name: 'Finish now' }));
    expect(sdkMock.runQueueCommandLegacy).toHaveBeenCalledWith({
      name: QueueName.MetadataExtraction,
      queueCommandDto: { command: QueueCommand.Start, force: false },
    });
  });

  it('"Keep what I wrote myself" off warns, and "Redo only what changed" writes its setting', async () => {
    const store = newStore();
    render(CareProgress, { pollMs: 60_000 });

    await fireEvent.click(await screen.findByRole('switch', { name: 'Keep what I wrote myself' }));
    expect(store.draft.libraryCare?.manualMetadata).toBe(false);
    expect(screen.getByText('Descriptions written by hand can now be replaced')).toBeInTheDocument();

    await fireEvent.click(screen.getByRole('switch', { name: 'Redo only what changed' }));
    expect(store.draft.libraryCare?.incrementalEnrichment).toBe(false);
  });
});
