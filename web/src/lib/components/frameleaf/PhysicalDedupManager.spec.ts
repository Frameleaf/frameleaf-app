import * as sdk from '@immich/sdk';
import {
  AssetTypeEnum,
  MediaOperationStatus,
  PhysicalDeduplicationDecision,
  PhysicalDeduplicationPlanMode,
  PhysicalDeduplicationSkipReason,
  type PhysicalDeduplicationApplyDto,
  type PhysicalDeduplicationPlanDto,
  type PhysicalDeduplicationPreviewResponseDto,
  type UserAdminResponseDto,
} from '@immich/sdk';
import { fireEvent, screen, waitFor, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import type { Mock } from 'vitest';
import { goto } from '$app/navigation';
import PhysicalDedupManager from '$lib/components/frameleaf/PhysicalDedupManager.svelte';
import { renderWithTooltips as render } from '$tests/helpers';
import en from '../../../../../i18n/en.json';

// The verification endpoints (FL-73) are hand-added to the SDK source until it is regenerated, so
// they are declared on the mock explicitly rather than read from the built module.
vi.mock('@immich/sdk', async (originalImport) => {
  const module = await originalImport<typeof import('@immich/sdk')>();
  const mocks: Record<string, Mock> = {};
  for (const [key, value] of Object.entries(module)) {
    if (typeof value === 'function') {
      mocks[key] = vi.fn();
    }
  }
  return {
    ...module,
    ...mocks,
    verifyPhysicalDeduplicationApply: vi.fn(),
    restorePhysicalDeduplicationCopy: vi.fn(),
  };
});
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));

const api = sdk as unknown as Record<string, Mock>;

const users = [
  { id: 'taylor', name: 'Taylor', email: 'taylor@example.com' },
  { id: 'jamie', name: 'Jamie', email: 'jamie@example.com' },
] as UserAdminResponseDto[];

const plan = (overrides: Partial<PhysicalDeduplicationPlanDto> = {}): PhysicalDeduplicationPlanDto =>
  ({
    mode: PhysicalDeduplicationPlanMode.DryRun,
    ranAt: '2026-09-22T12:00:00.000Z',
    masterUserId: 'taylor',
    masterUserName: 'Taylor',
    scopeUserId: null,
    scopeUserName: null,
    eligibleAssets: 1,
    linkedAssets: 0,
    skippedExternal: 0,
    skippedMissingMaster: 1,
    reclaimableBytes: 2048,
    deletedBytes: 0,
    logicalBytes: 4096,
    sharedOriginalBytes: 2048,
    retained: [
      {
        assetId: 'lake',
        ownerId: 'taylor',
        ownerName: 'Taylor',
        canView: false,
        originalFileName: 'Moraine Lake.jpg',
        originalPath: '/upload/taylor/lake.jpg',
        type: AssetTypeEnum.Image,
        sizeInBytes: 2048,
        checksum: 'a'.repeat(40),
        referencesBefore: 1,
        referencesAfter: 2,
        hiddenCopies: 0,
        fileAvailable: true,
        width: 6000,
        height: 4000,
        duration: null,
      },
      {
        assetId: 'trail',
        ownerId: 'taylor',
        ownerName: 'Taylor',
        canView: false,
        originalFileName: 'Mountain trail.jpg',
        originalPath: '/upload/taylor/trail.jpg',
        type: AssetTypeEnum.Image,
        sizeInBytes: 1024,
        checksum: 'd'.repeat(40),
        referencesBefore: 1,
        referencesAfter: 1,
        hiddenCopies: 0,
        fileAvailable: false,
        width: null,
        height: null,
        duration: null,
      },
    ],
    copies: [
      {
        assetId: 'lake-j',
        ownerId: 'jamie',
        ownerName: 'Jamie',
        canView: false,
        originalFileName: 'Moraine Lake.jpg',
        originalPath: '/upload/jamie/lake.jpg',
        type: AssetTypeEnum.Image,
        sizeInBytes: 2048,
        checksum: 'a'.repeat(40),
        retainedAssetId: 'lake',
        checksumMatch: true,
        decision: PhysicalDeduplicationDecision.Share,
        reason: null,
        width: 6000,
        height: 4000,
        duration: null,
      },
      {
        assetId: 'trail-j',
        ownerId: 'jamie',
        ownerName: 'Jamie',
        canView: false,
        originalFileName: 'Mountain trail.jpg',
        originalPath: '/upload/jamie/trail.jpg',
        type: AssetTypeEnum.Image,
        sizeInBytes: 1024,
        checksum: 'd'.repeat(40),
        retainedAssetId: 'trail',
        checksumMatch: true,
        decision: PhysicalDeduplicationDecision.Skip,
        reason: PhysicalDeduplicationSkipReason.RetainedFileMissing,
        width: null,
        height: null,
        duration: null,
      },
    ],
    copiesTruncated: false,
    planId: 'PD-ABABABAB',
    fingerprint: 'ab'.repeat(32),
    applicableCopies: 1,
    hiddenCopies: 0,
    ...overrides,
  }) as PhysicalDeduplicationPlanDto;

const apply = (overrides: Partial<PhysicalDeduplicationApplyDto> = {}): PhysicalDeduplicationApplyDto => ({
  operationId: 'operation-1',
  planId: 'PD-ABABABAB',
  fingerprint: 'ab'.repeat(32),
  status: MediaOperationStatus.Completed,
  requestedById: 'taylor',
  requestedByName: 'Taylor',
  mine: true,
  retrying: false,
  pauseRequested: false,
  total: 1,
  processed: 1,
  progress: 100,
  applied: 1,
  alreadyApplied: 0,
  skipped: 0,
  failed: 0,
  estimatedBytes: 2048,
  reclaimedBytes: 2048,
  error: null,
  createdAt: '2026-09-22T12:05:00.000Z',
  finishedAt: '2026-09-22T12:06:00.000Z',
  ...overrides,
});

const preview = (overrides: Partial<PhysicalDeduplicationPreviewResponseDto> = {}) =>
  ({
    plan: null,
    savedMasterUserId: 'taylor',
    enabled: true,
    running: false,
    applying: false,
    applies: [],
    ...overrides,
  }) as PhysicalDeduplicationPreviewResponseDto;

const prepareButton = () => screen.getByRole('button', { name: en.frameleaf_dedup_prepare });

beforeEach(() => {
  vi.clearAllMocks();
  addMessages('dev', en);
  // The account pickers' combobox measures the visual viewport, which jsdom lacks.
  vi.stubGlobal('visualViewport', null);
});

describe('PhysicalDedupManager configuration error (FL-73, UT-23)', () => {
  it('asks to enable file reuse and keeps Prepare disabled', () => {
    render(PhysicalDedupManager, { users, initial: preview({ enabled: false }) });

    const message = screen.getByText(en.frameleaf_dedup_config_disabled).closest('p')!;
    expect(message).toHaveAttribute('role', 'status');
    expect(within(message).getByRole('button', { name: en.frameleaf_dedup_open_settings })).toBeInTheDocument();
    expect(prepareButton()).toBeDisabled();
  });

  it('asks for an account to retain shared originals in when there is none to choose', () => {
    render(PhysicalDedupManager, { users: [], initial: preview({ savedMasterUserId: null }) });

    expect(screen.getByText(en.frameleaf_dedup_config_no_master)).toBeInTheDocument();
    expect(prepareButton()).toBeDisabled();
  });

  it('opens Storage at the retained-account setting', async () => {
    render(PhysicalDedupManager, { users, initial: preview({ enabled: false }) });

    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_dedup_open_settings }));

    expect(goto).toHaveBeenCalledWith(expect.stringContaining('openSetting=dedup-owner'));
  });

  it('prepares once file reuse is on and an account is saved', async () => {
    api.requestPhysicalDeduplicationPreview.mockResolvedValue(undefined);
    render(PhysicalDedupManager, { users, initial: preview() });

    expect(screen.queryByText(en.frameleaf_dedup_config_disabled)).toBeNull();
    await fireEvent.click(prepareButton());

    expect(api.requestPhysicalDeduplicationPreview).toHaveBeenCalledWith({
      physicalDeduplicationPreviewRequestDto: { masterUserId: undefined, scopeUserId: undefined },
    });
  });

  it('shows the saved account by name with a Change button, not a link (UT-25)', async () => {
    render(PhysicalDedupManager, { users, initial: preview() });

    expect(screen.queryByText(/taylor@example\.com/)).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_dedup_retained_change }));
    expect(goto).toHaveBeenCalledWith(expect.stringContaining('openSetting=dedup-owner'));
  });
});

describe('PhysicalDedupManager plan evidence (FL-73)', () => {
  it('marks an unavailable retained original and skips its copies (UT-24)', async () => {
    render(PhysicalDedupManager, { users, initial: preview({ plan: plan() }) });

    // Media view: the prototype's overlay on the retained thumbnail.
    expect(screen.getByText(en.frameleaf_dedup_unavailable)).toBeInTheDocument();
    expect(screen.getByText(/Retained copy unavailable/)).toBeInTheDocument();

    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_dedup_view_evidence }));
    expect(screen.getByText(en.frameleaf_dedup_table_file_available)).toBeInTheDocument();
    expect(screen.getByText(en.frameleaf_dedup_table_file_unavailable)).toBeInTheDocument();
    expect(screen.getAllByText(en.frameleaf_dedup_retained_location).length).toBe(2);
  });

  it('adds dimensions to the detail line (UT-25)', () => {
    render(PhysicalDedupManager, { users, initial: preview({ plan: plan() }) });

    expect(screen.getByText('Taylor · 2 KiB · 6000 × 4000')).toBeInTheDocument();
    expect(screen.getByText('Moraine Lake.jpg · 2 KiB · 6000 × 4000')).toBeInTheDocument();
  });

  it('keeps logical, shared-original and measured bytes apart', () => {
    render(PhysicalDedupManager, { users, initial: preview({ plan: plan() }) });

    const bytes = screen.getByLabelText(en.frameleaf_dedup_bytes_label);
    expect(within(bytes).getByText(en.frameleaf_dedup_bytes_logical).nextElementSibling).toHaveTextContent('4 KiB');
    expect(within(bytes).getByText(en.frameleaf_dedup_bytes_shared).nextElementSibling).toHaveTextContent('2 KiB');
    expect(within(bytes).getByText(en.frameleaf_dedup_bytes_measured).nextElementSibling).toHaveTextContent(
      en.frameleaf_dedup_bytes_not_applied,
    );
  });

  it('never offers Apply before the plan on screen is reviewed', () => {
    render(PhysicalDedupManager, { users, initial: preview({ plan: plan() }) });

    expect(screen.getByRole('button', { name: en.frameleaf_dedup_mark_reviewed })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: en.frameleaf_dedup_apply })).toBeNull();
  });
});

describe('PhysicalDedupManager verification (FL-73)', () => {
  const report = (restorable: boolean) => ({
    operationId: 'operation-1',
    planId: 'PD-ABABABAB',
    verifiedAt: '2026-09-22T12:10:00.000Z',
    copies: 1,
    verified: 1,
    retainedOriginals: 1,
    retainedIntact: 1,
    retainedMissing: 0,
    retainedChanged: 0,
    notLinked: 0,
    restored: 0,
    restorable: restorable ? 1 : 0,
    removed: restorable ? 0 : 1,
    hiddenCopies: 0,
    items: [
      {
        assetId: 'lake-j',
        ownerName: 'Jamie',
        originalFileName: 'Moraine Lake.jpg',
        type: AssetTypeEnum.Image,
        canView: false,
        retainedFile: 'intact',
        linked: true,
        copyFile: restorable ? 'present' : 'removed',
        restored: false,
        restorable,
      },
    ],
  });

  const applied = () =>
    preview({ plan: plan({ mode: PhysicalDeduplicationPlanMode.Apply, deletedBytes: 2048 }), applies: [apply()] });

  it('verifies a finished apply and says a removed copy cannot be undone', async () => {
    api.verifyPhysicalDeduplicationApply.mockResolvedValue(report(false));
    render(PhysicalDedupManager, { users, initial: applied() });

    await fireEvent.click(screen.getAllByRole('button', { name: en.frameleaf_dedup_verify })[0]);

    expect(api.verifyPhysicalDeduplicationApply).toHaveBeenCalledWith({ id: 'operation-1' });
    const panel = await screen.findByRole('region', { name: 'Verification of PD-ABABABAB' });
    expect(within(panel).getByText(/cannot come back/)).toBeInTheDocument();
    expect(within(panel).getByText(en.frameleaf_dedup_undo_removed)).toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: en.frameleaf_dedup_restore })).toBeNull();
  });

  it('restores a copy whose own file is still on disk', async () => {
    api.verifyPhysicalDeduplicationApply.mockResolvedValue(report(true));
    api.restorePhysicalDeduplicationCopy.mockResolvedValue({ ...report(false), restored: 1 });
    render(PhysicalDedupManager, { users, initial: applied() });

    await fireEvent.click(screen.getAllByRole('button', { name: en.frameleaf_dedup_verify })[0]);
    const panel = await screen.findByRole('region', { name: 'Verification of PD-ABABABAB' });
    await fireEvent.click(within(panel).getByRole('button', { name: en.frameleaf_dedup_restore }));

    await waitFor(() =>
      expect(api.restorePhysicalDeduplicationCopy).toHaveBeenCalledWith({
        id: 'operation-1',
        physicalDeduplicationRestoreRequestDto: { assetId: 'lake-j' },
      }),
    );
  });

  it('reports the measured bytes of the applied plan', () => {
    render(PhysicalDedupManager, { users, initial: applied() });

    expect(screen.getByText(en.frameleaf_dedup_bytes_measured).nextElementSibling).toHaveTextContent('2 KiB');
  });
});
