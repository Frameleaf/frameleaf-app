import {
  CloudBackupDrillResult,
  CloudBackupDrillStep,
  CloudBackupDrillTrigger,
  type CloudBackupDrillDto,
  type CloudBackupStatusResponseDto,
} from '@frameleaf/sdk';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { addMessages } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import RestoreDrillCard from '$lib/components/frameleaf/backup/RestoreDrillCard.svelte';
import en from '../../../../../../i18n/en.json';

const drill = (overrides: Partial<CloudBackupDrillDto> = {}): CloudBackupDrillDto => ({
  id: '00000000-0000-7000-8000-000000000001',
  target: 'managed',
  trigger: CloudBackupDrillTrigger.Scheduled,
  startedAt: '2026-11-08T03:40:00.000Z',
  finishedAt: '2026-11-08T03:46:12.000Z',
  result: CloudBackupDrillResult.Passed,
  failedStep: null,
  backupFrom: '2026-11-08T02:00:00.000Z',
  library: { items: 48_210, photos: 44_860, videos: 3350, albums: 12 },
  restored: { asset: 48_210, user: 3, album: 12 },
  sampleSize: 500,
  checked: 500,
  matched: 500,
  mismatches: [],
  durationSeconds: 372,
  keyFingerprint: 'abcd1234',
  signed: true,
  ...overrides,
});

const status = (overrides: Partial<CloudBackupStatusResponseDto> = {}) =>
  ({
    configured: true,
    target: 'managed',
    activeRun: null,
    lastDrill: null,
    drillDue: true,
    nextDrillAt: null,
    drillNeedsAttention: false,
    ...overrides,
  }) as CloudBackupStatusResponseDto;

describe('RestoreDrillCard (FL-900)', () => {
  beforeAll(() => addMessages('dev', en));
  beforeEach(() => vi.clearAllMocks());

  it('has never run: says so, and runs one on request', async () => {
    const onStatus = vi.fn();
    sdkMock.startCloudBackupDrill.mockResolvedValue(status() as never);
    render(RestoreDrillCard, { status: status(), onStatus });
    expect(screen.getByRole('heading', { name: 'Your backup hasn’t been proven to restore yet' })).toBeInTheDocument();
    expect(screen.getByText('Never')).toBeInTheDocument();
    expect(screen.getByText('Tonight, after the backup')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /See the report/ })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /Run a drill now/ }));
    expect(sdkMock.startCloudBackupDrill).toHaveBeenCalled();
    expect(onStatus).toHaveBeenCalled();
  });

  it('is running: shows the steps, not the buttons', () => {
    render(RestoreDrillCard, {
      status: status({ activeRun: { drill: true, progress: 30, task: 'verify' } as never }),
      onStatus: vi.fn(),
    });
    expect(screen.getByRole('heading', { name: 'Proving your backup restores…' })).toBeInTheDocument();
    const steps = screen.getByRole('list', { name: 'Drill steps' }).querySelectorAll('li');
    expect([...steps].map((step) => step.dataset.state)).toEqual(['done', 'done', 'running', 'waiting']);
    expect(screen.queryByRole('button', { name: /Run a drill now/ })).toBeNull();
  });

  it('passed: says how much matched, when the next drill is, and links to the report', () => {
    render(RestoreDrillCard, {
      status: status({ lastDrill: drill(), drillDue: false, nextDrillAt: '2026-12-08T03:40:00.000Z' }),
      onStatus: vi.fn(),
    });
    expect(screen.getByRole('heading', { name: 'Your backup restored correctly' })).toBeInTheDocument();
    expect(screen.getByText(/500 of 500 sample photos and videos matched/)).toBeInTheDocument();
    expect(screen.getByText(/^Passed, /)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /See the report/ })).toHaveAttribute(
      'href',
      expect.stringContaining('drill=00000000-0000-7000-8000-000000000001'),
    );
  });

  it('failed: names the step in plain words and offers the recovery key', () => {
    render(RestoreDrillCard, {
      status: status({
        lastDrill: drill({ result: CloudBackupDrillResult.Failed, failedStep: CloudBackupDrillStep.Unlock }),
        drillNeedsAttention: true,
      }),
      onStatus: vi.fn(),
    });
    expect(screen.getByRole('heading', { name: 'Your backup didn’t restore' })).toBeInTheDocument();
    expect(screen.getByText(/The recovery key on this server didn’t unlock the backup\./)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Check the recovery key' })).toBeInTheDocument();
    expect(screen.getByText(/^Failed, /)).toBeInTheDocument();
  });

  it('stops following a running drill once the card is gone', async () => {
    vi.useFakeTimers();
    try {
      const running = status({ activeRun: { drill: true, progress: 30, task: 'verify' } as never });
      let answer: (value: CloudBackupStatusResponseDto) => void = () => {};
      sdkMock.getCloudBackupStatus.mockImplementation(() => new Promise((resolve) => (answer = resolve)) as never);
      const onStatus = vi.fn();
      const { unmount } = render(RestoreDrillCard, { status: running, onStatus });
      await vi.advanceTimersByTimeAsync(3000);
      expect(sdkMock.getCloudBackupStatus).toHaveBeenCalledTimes(1);
      unmount();
      answer(running);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(onStatus).not.toHaveBeenCalled();
      expect(sdkMock.getCloudBackupStatus).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
