import * as sdk from '@frameleaf/sdk';
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
} from '@frameleaf/sdk';
import { fireEvent, screen, waitFor, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import type { Mock } from 'vitest';
import { goto } from '$app/navigation';
import PhysicalDedupManager from '$lib/components/frameleaf/PhysicalDedupManager.svelte';
import { renderWithTooltips as render } from '$tests/helpers';
import en from '../../../../../i18n/en.json';

// The verification endpoints (FL-73) are hand-added to the SDK source until it is regenerated, so
// they are declared on the mock explicitly rather than read from the built module.
vi.mock('@frameleaf/sdk', async (originalImport) => {
  const module = await originalImport<typeof import('@frameleaf/sdk')>();
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

const findButton = () => screen.getByRole('button', { name: en.frameleaf_dupes_merge_find });

beforeEach(() => {
  vi.clearAllMocks();
  addMessages('dev', en);
  vi.stubGlobal('visualViewport', null);
});

describe('Merge older copies: opens on what was found (FL-366)', () => {
  it('says how many extra copies can be merged and the space they give back', () => {
    render(PhysicalDedupManager, { users, initial: preview({ plan: plan() }) });

    const hero = screen.getByRole('region', { name: en.frameleaf_dupes_merge_status });
    expect(within(hero).getByRole('heading', { name: '1 extra copy can be merged' })).toBeInTheDocument();
    expect(within(hero).getByText(/Merging gets back 2 KiB\. Everyone keeps every photo\./)).toBeInTheDocument();
  });

  it('opens on looking for older copies before any search', () => {
    render(PhysicalDedupManager, { users, initial: preview() });

    expect(screen.getByRole('heading', { name: en.frameleaf_dupes_merge_hero_start })).toBeInTheDocument();
    expect(findButton()).toBeEnabled();
  });
});

describe('Merge older copies: where to look (FL-73, FL-366)', () => {
  it('keeps Find exact copies off while merging is turned off, without sending anyone elsewhere', () => {
    render(PhysicalDedupManager, { users, initial: preview({ enabled: false }) });

    expect(screen.getByText(en.frameleaf_dupes_merge_disabled)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: en.frameleaf_dedup_open_settings })).toBeNull();
    expect(findButton()).toBeDisabled();
    expect(goto).not.toHaveBeenCalled();
  });

  it('says there is no account to keep the shared file with when there is none', () => {
    render(PhysicalDedupManager, { users: [], initial: preview({ savedMasterUserId: null }) });

    expect(screen.getByText(en.frameleaf_dupes_merge_no_account)).toBeInTheDocument();
    expect(findButton()).toBeDisabled();
  });

  it('looks with the person chosen on this page', async () => {
    api.requestPhysicalDeduplicationPreview.mockResolvedValue(undefined);
    render(PhysicalDedupManager, { users, initial: preview({ savedMasterUserId: null }) });

    await fireEvent.change(screen.getByRole('combobox', { name: en.frameleaf_dupes_merge_keep_with }), {
      target: { value: 'jamie' },
    });
    await fireEvent.click(findButton());

    expect(api.requestPhysicalDeduplicationPreview).toHaveBeenCalledWith({
      physicalDeduplicationPreviewRequestDto: { masterUserId: 'jamie', scopeUserId: undefined },
    });
  });

  it('names whose photos to look in, in plain words', () => {
    render(PhysicalDedupManager, { users, initial: preview() });

    const lookIn = screen.getByRole('combobox', { name: en.frameleaf_dupes_merge_look_in });
    expect(within(lookIn).getByRole('option', { name: 'Everyone’s photos' })).toBeInTheDocument();
    expect(within(lookIn).getByRole('option', { name: 'Only Jamie’s photos' })).toBeInTheDocument();
  });
});

describe('PhysicalDedupManager plan evidence (FL-73)', () => {
  it('marks an unavailable retained original and skips its copies (UT-24)', async () => {
    render(PhysicalDedupManager, { users, initial: preview({ plan: plan() }) });

    // Media view: the prototype's overlay on the retained thumbnail.
    expect(screen.getByText(en.frameleaf_dedup_unavailable)).toBeInTheDocument();
    expect(screen.getAllByText(/Retained copy unavailable/).length).toBeGreaterThan(0);

    expect(screen.getByText(en.frameleaf_dedup_table_file_available)).toBeInTheDocument();
    expect(screen.getByText(en.frameleaf_dedup_table_file_unavailable)).toBeInTheDocument();
    expect(screen.getAllByText(en.frameleaf_dedup_retained_location).length).toBe(2);
  });

  it('names the checksum algorithm from the data under Checksum evidence, with the plan caption (PD-A)', async () => {
    const withSha256 = plan();
    withSha256.copies[0].checksum = 'b'.repeat(64);
    render(PhysicalDedupManager, { users, initial: preview({ plan: withSha256 }) });

    const table = screen.getByRole('table');
    expect(within(table).getAllByText('Checksum evidence', { selector: 'summary' })).toHaveLength(2);
    expect(within(table).getByText('SHA-256 · stored checksum')).toBeInTheDocument();
    expect(within(table).getByText('SHA-1 · stored checksum')).toBeInTheDocument();
    expect(within(table).getByText('1 → 2')).toBeInTheDocument();
    expect(within(table).getAllByText('Across this plan').length).toBeGreaterThan(0);
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

  it('never offers Merge before the list on screen is checked', () => {
    render(PhysicalDedupManager, { users, initial: preview({ plan: plan() }) });

    expect(screen.getByRole('checkbox', { name: en.frameleaf_dupes_merge_checked })).not.toBeChecked();
    expect(screen.getByRole('button', { name: en.frameleaf_dupes_merge_go })).toBeDisabled();
  });

  it('merges only after the list is checked and the phrase typed, with the page-chosen person', async () => {
    api.getPhysicalDeduplicationPreview.mockResolvedValue(preview());
    api.reviewPhysicalDeduplicationPlan.mockResolvedValue({
      fingerprint: plan().fingerprint,
      excludedRetainedAssetIds: [],
      reviewToken: 'review-token',
      copies: 1,
      retainedOriginals: 1,
      hiddenCopies: 0,
      estimatedBytes: 2048,
    });
    render(PhysicalDedupManager, { users, initial: preview({ savedMasterUserId: null, plan: plan() }) });

    await fireEvent.click(screen.getByRole('checkbox', { name: en.frameleaf_dupes_merge_checked }));
    expect(api.reviewPhysicalDeduplicationPlan).toHaveBeenCalledWith({
      physicalDeduplicationReviewRequestDto: { fingerprint: plan().fingerprint, excludedRetainedAssetIds: [] },
    });
    await waitFor(() => expect(screen.getByRole('button', { name: en.frameleaf_dupes_merge_go })).toBeEnabled());
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_dupes_merge_go }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/The extra files move to File trash/)).toBeInTheDocument();
    const confirm = within(dialog).getByRole('button', { name: 'Merge 1 copy' });
    expect(confirm).toBeDisabled();
    expect(api.applyPhysicalDeduplicationPlan).not.toHaveBeenCalled();
    await fireEvent.input(screen.getByRole('textbox', { name: 'Type APPLY PD-ABABABAB to confirm' }), {
      target: { value: 'APPLY PD-ABABABAB' },
    });
    await fireEvent.click(confirm);
    expect(api.applyPhysicalDeduplicationPlan).toHaveBeenCalledWith({
      physicalDeduplicationApplyRequestDto: {
        fingerprint: plan().fingerprint,
        reviewToken: 'review-token',
        excludedRetainedAssetIds: [],
        confirmation: 'APPLY PD-ABABABAB',
      },
    });
  });
});

describe('PhysicalDedupManager checked list (FL-366)', () => {
  it('asks to check the list again when a group decision changes after the check', async () => {
    api.reviewPhysicalDeduplicationPlan.mockResolvedValue({
      fingerprint: plan().fingerprint,
      excludedRetainedAssetIds: [],
      reviewToken: 'review-token',
      copies: 1,
      retainedOriginals: 1,
      hiddenCopies: 0,
      estimatedBytes: 2048,
    });
    render(PhysicalDedupManager, { users, initial: preview({ plan: plan() }) });

    await fireEvent.click(screen.getByRole('checkbox', { name: en.frameleaf_dupes_merge_checked }));
    await waitFor(() => expect(screen.getByRole('button', { name: en.frameleaf_dupes_merge_go })).toBeEnabled());
    await fireEvent.click(screen.getAllByRole('checkbox', { name: en.frameleaf_dupes_merge_include })[0]);

    expect(screen.getByRole('checkbox', { name: en.frameleaf_dupes_merge_checked })).not.toBeChecked();
    expect(screen.getByRole('button', { name: en.frameleaf_dupes_merge_go })).toBeDisabled();
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
