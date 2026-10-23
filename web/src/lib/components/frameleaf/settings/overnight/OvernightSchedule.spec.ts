import { OvernightStepResult } from '@frameleaf/sdk';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import en from '../../../../../../../i18n/en.json';
import OvernightSchedule from './OvernightSchedule.svelte';
import { nightOutcome, overnightWords, startsNearBackups } from './overnight';

const draft = vi.hoisted(() => ({ store: undefined as unknown }));
const sdk = vi.hoisted(() => ({
  getOvernight: vi.fn(),
  getBackupSchedule: vi.fn(),
  runOvernight: vi.fn(),
  stopOvernight: vi.fn(),
}));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('$lib/managers/feature-flags-manager.svelte', () => ({
  featureFlagsManager: { value: { configFile: false } },
}));
vi.mock('@frameleaf/sdk', async (original) => ({ ...(await original<typeof import('@frameleaf/sdk')>()), ...sdk }));
vi.mock('$lib/frameleaf/system-config-draft.svelte', async (original) => {
  const actual = await original<typeof import('$lib/frameleaf/system-config-draft.svelte')>();
  return { ...actual, getSystemConfigDraft: () => draft.store };
});

const config = () => ({
  nightlyTasks: {
    startTime: '00:00',
    stopTime: '06:00',
    days: [0, 1, 2, 3, 4, 5, 6],
    weeklyDay: 0,
    emptyTrash: true,
    databaseCleanup: true,
    missingThumbnails: true,
    clusterNewFaces: true,
    generateMemories: true,
    syncQuotaUsage: true,
    steps: { cleanup: 'nightly', folders: 'nightly', icloud: 'nightly', fileChecks: 'nightly' },
  },
  trash: { enabled: true, days: 30 },
});

describe('Overnight schedule (FL-363)', () => {
  beforeAll(() => addMessages('dev', en));
  beforeEach(() => {
    draft.store = { draft: config(), baseline: config() };
    sdk.getOvernight.mockReset().mockResolvedValue({
      timezone: 'UTC',
      nextRunAt: '2026-10-21T00:00:00.000Z',
      steps: [
        { id: 'cleanup', on: true, timing: 'nightly' },
        { id: 'folders', on: true, timing: 'nightly' },
        { id: 'icloud', on: false, timing: 'nightly' },
        { id: 'fileChecks', on: true, timing: 'nightly' },
      ],
      run: null,
      nights: [
        {
          startedAt: '2026-10-20T00:00:00.000Z',
          finishedAt: '2026-10-20T01:22:00.000Z',
          manual: false,
          results: { cleanup: 'done', folders: 'done', icloud: 'off', fileChecks: 'done' },
        },
      ],
    });
    sdk.getBackupSchedule.mockReset().mockResolvedValue({
      cronExpression: '0 2 * * *',
      chosen: true,
      timezone: 'UTC',
      nextRunAt: null,
      places: [{ id: 'local', on: true }],
      run: null,
      lastFinishedAt: null,
    });
    sdk.runOvernight.mockReset();
  });

  it('opens on how last night went, with the steps in order and Backup mirrored', async () => {
    render(OvernightSchedule);
    expect(await screen.findByRole('heading', { name: /Last night’s work finished at/ })).toBeInTheDocument();
    expect(screen.getAllByText('Empty Trash and tidy up').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Check added folders').length).toBeGreaterThan(0);
    // iCloud Photos is not set up, so it is not in tonight's order
    expect(screen.queryByText('Bring in new iCloud photos')).not.toBeInTheDocument();
    expect(screen.getByText('Every night at 12:00 AM, stopping at 6:00 AM.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Change in Backup' })).toBeInTheDocument();
    // no schedule expression and no operator wording anywhere
    expect(screen.queryByText(/\* \* \*/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Database cleanup|Sync quota usage/)).not.toBeInTheDocument();
  });

  it('says Trash is not emptied while the tidy-up is off, and switches it back on', async () => {
    const store = draft.store as { draft: ReturnType<typeof config> };
    store.draft.nightlyTasks.databaseCleanup = false;
    render(OvernightSchedule);
    expect(await screen.findByText('Trash is not being emptied')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Switch it back on' }));
    expect(store.draft.nightlyTasks.databaseCleanup).toBe(true);
  });

  it('runs the night’s work now', async () => {
    sdk.runOvernight.mockResolvedValue({ ...(await sdk.getOvernight()), run: null });
    render(OvernightSchedule);
    await fireEvent.click(await screen.findByRole('button', { name: 'Run now' }));
    expect(sdk.runOvernight).toHaveBeenCalled();
    expect(await screen.findByText(/Every step that is on runs now/)).toBeInTheDocument();
  });
});

describe('overnight rules', () => {
  it('tells a finished night from one that did not finish', () => {
    const { Done, Off, Stopped } = OvernightStepResult;
    expect(nightOutcome({ cleanup: Done, folders: Off, fileChecks: Done })).toEqual({
      ran: ['cleanup', 'fileChecks'],
      notFinished: [],
      problem: false,
    });
    expect(nightOutcome({ cleanup: Done, folders: Stopped }).problem).toBe(true);
  });

  it('words the schedule and warns when it starts with the backups', () => {
    expect(overnightWords({ someDays: false, stop: true })).toBe('frameleaf_overnight_words_night_stop');
    expect(overnightWords({ someDays: true, stop: false })).toBe('frameleaf_overnight_words_days');
    expect(startsNearBackups('01:30', '02:00')).toBe(true);
    expect(startsNearBackups('23:30', '00:10')).toBe(true);
    expect(startsNearBackups('00:00', '02:00')).toBe(false);
  });
});
