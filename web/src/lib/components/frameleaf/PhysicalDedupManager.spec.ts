import {
  AssetTypeEnum,
  PhysicalDeduplicationDecision,
  PhysicalDeduplicationPlanMode,
  type PhysicalDeduplicationPreviewResponseDto,
  type UserAdminResponseDto,
} from '@immich/sdk';
import { fireEvent, screen } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getVisualViewportMock } from '$lib/__mocks__/visual-viewport.mock';
import { renderWithTooltips } from '$tests/helpers';
import en from '../../../../../i18n/en.json';
import PhysicalDedupManager from './PhysicalDedupManager.svelte';

vi.mock('@immich/sdk', async (original) => ({
  ...(await original<typeof import('@immich/sdk')>()),
  getPhysicalDeduplicationPreview: vi.fn(),
  requestPhysicalDeduplicationPreview: vi.fn(),
}));

const users = [
  { id: 'taylor', name: 'Taylor', email: 'taylor@example.com' },
  { id: 'jamie', name: 'Jamie', email: 'jamie@example.com' },
] as UserAdminResponseDto[];

const preview = (
  overrides: Partial<PhysicalDeduplicationPreviewResponseDto> = {},
): PhysicalDeduplicationPreviewResponseDto => ({
  plan: null,
  savedMasterUserId: 'taylor',
  enabled: true,
  running: false,
  applying: false,
  applies: [],
  ...overrides,
});

const planWithMissingOriginal = (): PhysicalDeduplicationPreviewResponseDto['plan'] => ({
  mode: PhysicalDeduplicationPlanMode.DryRun,
  ranAt: '2026-09-22T12:00:00.000Z',
  masterUserId: 'taylor',
  masterUserName: 'Taylor',
  scopeUserId: null,
  scopeUserName: null,
  eligibleAssets: 1,
  linkedAssets: 0,
  skippedExternal: 0,
  skippedMissingMaster: 0,
  reclaimableBytes: 10,
  deletedBytes: 0,
  retained: [
    {
      assetId: 'master-1',
      ownerId: 'taylor',
      ownerName: 'Taylor',
      canView: false,
      fileAvailable: false,
      originalFileName: 'Moraine Lake.jpg',
      originalPath: '/upload/taylor/master-1.jpg',
      type: AssetTypeEnum.Image,
      sizeInBytes: 10,
      checksum: 'a'.repeat(40),
      referencesBefore: 1,
      referencesAfter: 2,
      hiddenCopies: 0,
    },
  ],
  copies: [
    {
      assetId: 'copy-1',
      ownerId: 'jamie',
      ownerName: 'Jamie',
      canView: false,
      originalFileName: 'Moraine Lake.jpg',
      originalPath: '/upload/jamie/copy-1.jpg',
      type: AssetTypeEnum.Image,
      sizeInBytes: 10,
      checksum: 'a'.repeat(40),
      retainedAssetId: 'master-1',
      checksumMatch: true,
      decision: PhysicalDeduplicationDecision.Share,
      reason: null,
    },
  ],
  copiesTruncated: false,
  planId: 'MORAINE-1',
  fingerprint: 'f',
  applicableCopies: 1,
  hiddenCopies: 0,
});

describe('PhysicalDedupManager (FL-71)', () => {
  beforeAll(() => {
    addMessages('dev', en);
  });

  beforeEach(() => {
    vi.stubGlobal('visualViewport', getVisualViewportMock());
  });

  it('says file reuse is off, offers Open settings and keeps Prepare disabled (UT-23)', () => {
    renderWithTooltips(PhysicalDedupManager, { users, initial: preview({ enabled: false }) });

    expect(screen.getByText('Enable file reuse before preparing a plan.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open settings' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Prepare preview plan' })).toBeDisabled();
  });

  it('prepares a preview when file reuse is on', () => {
    renderWithTooltips(PhysicalDedupManager, { users, initial: preview() });

    expect(screen.queryByText('Enable file reuse before preparing a plan.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Prepare preview plan' })).toBeEnabled();
  });

  it('offers a link to save a retained account when previews use the one chosen here (UT-25)', () => {
    renderWithTooltips(PhysicalDedupManager, { users, initial: preview({ savedMasterUserId: null }) });

    expect(screen.getByRole('link', { name: 'save a retained account' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Prepare preview plan' })).toBeEnabled();
  });

  it('marks a retained original that is no longer on disk (UT-24)', async () => {
    renderWithTooltips(PhysicalDedupManager, { users, initial: preview({ plan: planWithMissingOriginal() }) });

    expect(screen.getAllByText('Unavailable').length).toBeGreaterThan(0);

    await fireEvent.click(screen.getByRole('button', { name: 'Evidence' }));
    expect(screen.getByText('File unavailable')).toBeInTheDocument();
    expect(screen.queryByText('File available')).not.toBeInTheDocument();
  });
});
