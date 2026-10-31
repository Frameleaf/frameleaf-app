import {
  AttentionBackupPlace,
  AttentionCheckState,
  AttentionKind,
  AttentionLevel,
  AttentionReason,
  QueueName,
  type AttentionItemDto,
  type AttentionResponseDto,
} from '@frameleaf/sdk';
import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import AttentionPage from '$lib/components/frameleaf/settings/notifications/AttentionPage.svelte';
import en from '../../../../../../../i18n/en.json';

const GB = 1000 ** 3;
const checkedAt = new Date().toISOString();
const ok = (state = AttentionCheckState.Ok) =>
  [AttentionKind.Backup, AttentionKind.Storage, AttentionKind.Work, AttentionKind.Version].map((kind) => ({
    kind,
    state,
  }));
const item = (patch: Partial<AttentionItemDto>): AttentionItemDto => ({
  id: 'x',
  kind: AttentionKind.Backup,
  reason: AttentionReason.NotBackedUp,
  level: AttentionLevel.Soon,
  since: null,
  storage: null,
  backup: null,
  work: null,
  version: null,
  ...patch,
});
const answer = (patch: Partial<AttentionResponseDto> = {}): AttentionResponseDto => ({
  checkedAt,
  items: [],
  checks: ok(),
  dismissed: [],
  ...patch,
});
/** The answer at the top, once the page has read what needs attention. */
const hero = async () => within(await screen.findByRole('region', { name: en.frameleaf_attention_hero_label }));

describe('Notifications › What needs your attention (FL-421)', () => {
  beforeAll(() => addMessages('dev', en));
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('says nothing needs attention, and how each check came out', async () => {
    sdkMock.getAttention.mockResolvedValue(answer());
    render(AttentionPage);

    expect(await screen.findByRole('heading', { name: en.frameleaf_attention_hero_none })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: en.frameleaf_attention_now_title })).not.toBeInTheDocument();
    const table = screen.getByRole('table', { name: en.frameleaf_attention_checks_title });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((row) => within(row).getByRole('rowheader').querySelector('strong')?.textContent)).toEqual([
      en.frameleaf_attention_check_storage,
      en.frameleaf_attention_check_backup,
      en.frameleaf_attention_check_work,
      en.frameleaf_attention_check_version,
    ]);
    expect(within(table).getAllByText(en.frameleaf_attention_state_ok)).toHaveLength(4);
    expect(within(table).getByRole('link', { name: en.frameleaf_attention_check_backup_link })).toHaveAttribute(
      'href',
      '/user-settings?area=backups',
    );
  });

  it('lists each thing that needs attention, the most urgent first, with the page that puts it right', async () => {
    sdkMock.getAttention.mockResolvedValue(
      answer({
        items: [
          item({
            id: 'storage',
            kind: AttentionKind.Storage,
            reason: AttentionReason.OutOfSpace,
            level: AttentionLevel.Now,
            storage: { availableBytes: 9 * GB, totalBytes: 500 * GB, usedPercent: 98.2 },
          }),
          item({
            id: 'backup:buddy',
            reason: AttentionReason.BackupBehind,
            since: checkedAt,
            backup: { place: AttentionBackupPlace.Buddy, lastSuccessAt: checkedAt, days: 3 },
          }),
          item({
            id: 'work:failed',
            kind: AttentionKind.Work,
            reason: AttentionReason.WorkFailed,
            work: { count: 12, queues: [{ name: QueueName.VideoConversion, count: 12 }] },
          }),
        ],
        checks: [
          { kind: AttentionKind.Backup, state: AttentionCheckState.Attention },
          { kind: AttentionKind.Storage, state: AttentionCheckState.Attention },
          { kind: AttentionKind.Work, state: AttentionCheckState.Attention },
          { kind: AttentionKind.Version, state: AttentionCheckState.Off },
        ],
      }),
    );
    render(AttentionPage);

    expect((await hero()).getByRole('heading', { name: '3 things need your attention' })).toBeInTheDocument();
    const list = screen.getByRole('region', { name: en.frameleaf_attention_now_title });
    expect(within(list).getByText(en.frameleaf_attention_storage_out_title)).toBeInTheDocument();
    expect(within(list).getByText(/The photo drive has 9 GB left of 500 GB\./)).toBeInTheDocument();
    expect(within(list).getByText(en.frameleaf_attention_level_now)).toBeInTheDocument();
    expect(within(list).getByText('Buddy Backup hasn’t finished a backup in 3 days.')).toBeInTheDocument();
    expect(within(list).getByText(/^Last finished today/)).toBeInTheDocument();
    expect(within(list).getByText('12 things failed in background work')).toBeInTheDocument();
    expect(within(list).getByRole('link', { name: en.frameleaf_attention_open_backup })).toHaveAttribute(
      'href',
      '/user-settings?area=backups&section=buddy',
    );
    expect(within(list).getByRole('link', { name: en.frameleaf_attention_open_work })).toHaveAttribute(
      'href',
      '/user-settings?area=processing&section=queues',
    );

    const table = screen.getByRole('table', { name: en.frameleaf_attention_checks_title });
    expect(within(table).getAllByText(en.frameleaf_attention_state_attention)).toHaveLength(3);
    expect(within(table).getByText(en.frameleaf_attention_state_off)).toBeInTheDocument();
  });

  it('says which checks could not be read instead of saying everything is fine', async () => {
    sdkMock.getAttention.mockResolvedValue(
      answer({
        checks: [
          { kind: AttentionKind.Backup, state: AttentionCheckState.Ok },
          { kind: AttentionKind.Storage, state: AttentionCheckState.Unknown },
          { kind: AttentionKind.Work, state: AttentionCheckState.Ok },
          { kind: AttentionKind.Version, state: AttentionCheckState.Unknown },
        ],
      }),
    );
    render(AttentionPage);

    const top = await hero();
    expect(top.getByRole('heading', { name: en.frameleaf_attention_hero_unread })).toBeInTheDocument();
    expect(top.getByText(/couldn’t check the drive your library is on just now/)).toBeInTheDocument();
    expect(screen.getByText(en.frameleaf_attention_state_not_yet)).toBeInTheDocument();
  });

  it('offers to try again when the server could not be asked', async () => {
    sdkMock.getAttention.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(answer());
    render(AttentionPage);

    expect(await screen.findByText(en.frameleaf_attention_load_failed)).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: /try again|retry/i }));
    expect(await screen.findByRole('heading', { name: en.frameleaf_attention_hero_none })).toBeInTheDocument();
    expect(sdkMock.getAttention).toHaveBeenCalledTimes(2);
  });
});
