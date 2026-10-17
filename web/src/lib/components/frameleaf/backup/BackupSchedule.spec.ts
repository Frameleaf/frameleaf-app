import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import BackupSchedule from '$lib/components/frameleaf/backup/BackupSchedule.svelte';
import en from '../../../../../../i18n/en.json';

const draft = vi.hoisted(() => ({
  backup: {
    database: { enabled: true, cronExpression: '0 02 * * *', keepLastAmount: 14 },
    schedule: { cronExpression: '' },
  },
  frameleafCloud: { cloudBackup: { schedule: { cronExpression: '0 3 * * *' } } },
}));
vi.mock('$lib/managers/feature-flags-manager.svelte', () => ({
  featureFlagsManager: { value: { configFile: false } },
}));
vi.mock('$lib/frameleaf/system-config-draft.svelte', () => ({ getSystemConfigDraft: () => ({ draft }) }));

const server = (cronExpression: string, patch: Record<string, unknown> = {}) =>
  ({
    cronExpression,
    chosen: false,
    timezone: new Intl.DateTimeFormat().resolvedOptions().timeZone,
    nextRunAt: null,
    places: [
      { id: 'local', on: true },
      { id: 'buddy', on: false },
      { id: 'cloud', on: true },
    ],
    run: null,
    lastFinishedAt: null,
    ...patch,
  }) as never;

const sentence = () => screen.getByRole('complementary', { name: 'What this schedule does' });

describe('Backup › Schedule (FL-362)', () => {
  beforeAll(() => addMessages('dev', en));

  beforeEach(() => {
    vi.clearAllMocks();
    draft.backup.schedule.cronExpression = '';
    draft.backup.database.cronExpression = '0 02 * * *';
    draft.frameleafCloud.cloudBackup.schedule.cronExpression = '0 3 * * *';
  });

  it('says the schedule in force back in words, with the order of the places that are on', async () => {
    sdkMock.getBackupSchedule.mockResolvedValue(server('0 02 * * *'));
    render(BackupSchedule);
    expect(await within(sentence()).findByText(/^Every day at 2:00\sAM\.$/)).toBeInTheDocument();
    const order = within(sentence()).getByRole('list', { name: 'The order backups run in' });
    expect(
      within(order)
        .getAllByRole('listitem')
        .map((item) => item.querySelector('strong')?.textContent),
    ).toEqual(['On this server', 'Cloud Backup']);
    expect(within(order).getByText(en.frameleaf_backup_schedule_step_then)).toBeInTheDocument();
    // No schedule expression anywhere on the page.
    expect(document.body.textContent).not.toMatch(/\* \*|cron/i);
  });

  // The settings draft is a plain object here, so each step starts from the schedule the one before left.
  const open = async (chosen = '') => {
    draft.backup.schedule.cronExpression = chosen;
    sdkMock.getBackupSchedule.mockResolvedValue(server('0 02 * * *'));
    const view = render(BackupSchedule);
    await within(sentence()).findByText(/^Every /);
    return view;
  };

  it('keeps a choice as the one schedule, and keeps the older schedule fields in step with it', async () => {
    await open();
    await fireEvent.click(screen.getByRole('button', { name: 'On chosen days' }));
    expect(draft.backup.schedule.cronExpression).toBe('0 2 * * 0');
    expect(draft.backup.database.cronExpression).toBe('0 2 * * 0');
    expect(draft.frameleafCloud.cloudBackup.schedule.cronExpression).toBe('0 2 * * 0');
  });

  it('adds and removes days, but never the last one', async () => {
    let view = await open('0 2 * * 0');
    expect(within(sentence()).getByText(/^Every Sunday at 2:00\sAM\.$/)).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Wednesday' }));
    expect(draft.backup.schedule.cronExpression).toBe('0 2 * * 0,3');
    view.unmount();

    view = await open('0 2 * * 0,3');
    await fireEvent.click(screen.getByRole('button', { name: 'Wednesday' }));
    expect(draft.backup.schedule.cronExpression).toBe('0 2 * * 0');
    view.unmount();

    await open('0 2 * * 0');
    await fireEvent.click(screen.getByRole('button', { name: 'Sunday' }));
    expect(draft.backup.schedule.cronExpression).toBe('0 2 * * 0');
  });

  it('takes a start time, and has none for every few hours', async () => {
    const view = await open('0 2 * * 0');
    await fireEvent.change(screen.getByLabelText('Start time'), { target: { value: '23:30' } });
    expect(draft.backup.schedule.cronExpression).toBe('30 23 * * 0');
    await fireEvent.click(screen.getByRole('button', { name: 'Every few hours' }));
    expect(draft.backup.schedule.cronExpression).toBe('0 */6 * * *');
    view.unmount();

    await open('0 */6 * * *');
    expect(screen.queryByLabelText('Start time')).toBeNull();
    expect(screen.getByLabelText('Hours between backups')).toHaveValue('6');
  });

  it('does not rewrite a schedule that is only spelled differently', async () => {
    sdkMock.getBackupSchedule.mockResolvedValue(server('0 02 * * *'));
    render(BackupSchedule);
    await within(sentence()).findByText(/^Every day/);
    await fireEvent.click(screen.getByRole('button', { name: 'Every day' }));
    expect(draft.backup.schedule.cronExpression).toBe('');
    expect(draft.backup.database.cronExpression).toBe('0 02 * * *');
  });

  it('shows a schedule it cannot express as Custom, leaves it alone, and replaces it on a choice', async () => {
    sdkMock.getBackupSchedule.mockResolvedValue(server('0 2 1 * *', { chosen: true }));
    render(BackupSchedule);
    expect(await screen.findByText(en.frameleaf_backup_schedule_custom_title)).toBeInTheDocument();
    expect(within(sentence()).getByText('On a custom schedule.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Start time')).toBeNull();
    for (const name of ['Every day', 'On chosen days', 'Every few hours']) {
      expect(screen.getByRole('button', { name })).toHaveAttribute('aria-pressed', 'false');
    }
    expect(draft.backup.schedule.cronExpression).toBe('');

    await fireEvent.click(screen.getByRole('button', { name: 'Every day' }));
    expect(draft.backup.schedule.cronExpression).toBe('0 2 * * *');
  });

  it('says so when no backup is switched on', async () => {
    sdkMock.getBackupSchedule.mockResolvedValue(server('0 02 * * *', { places: [{ id: 'local', on: false }] }));
    render(BackupSchedule);
    expect(await screen.findByText(en.frameleaf_backup_schedule_nothing_on)).toBeInTheDocument();
  });
});
