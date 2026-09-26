import { MediaOperationKind, MediaOperationStatus, type MediaOperationDto } from '@immich/sdk';
import { describe, expect, it } from 'vitest';
import { recentUtilityActivity, UTILITY_HISTORY_LIMIT } from '$lib/frameleaf/utility-history';

const operation = (index: number, overrides: Partial<MediaOperationDto> = {}): MediaOperationDto =>
  ({
    id: `op-${index}`,
    kind: MediaOperationKind.Bulk,
    status: MediaOperationStatus.Completed,
    label: `Job ${index}`,
    destination: 'local',
    progress: 100,
    processedUnits: 1,
    totalUnits: 1,
    autoRetries: 0,
    createdAt: new Date(Date.UTC(2026, 8, 1, 0, index)).toISOString(),
    startedAt: new Date(Date.UTC(2026, 8, 1, 0, index)).toISOString(),
    finishedAt: null,
    settings: {},
    ...overrides,
  }) as unknown as MediaOperationDto;

describe('recent utility activity (FL-69, UT-11)', () => {
  it('keeps the utilities’ own jobs, newest first, eight at most', () => {
    const operations = [
      ...Array.from({ length: 10 }, (_, index) => operation(index)),
      operation(20, { kind: MediaOperationKind.StudioExport, label: 'Render' }),
      operation(21, { kind: MediaOperationKind.IcloudSync, label: 'iCloud' }),
      operation(22, { kind: MediaOperationKind.MediaHealth, label: 'Library health scan' }),
    ];

    const items = recentUtilityActivity(operations);

    expect(items).toHaveLength(UTILITY_HISTORY_LIMIT);
    expect(items.map(({ title }) => title).slice(0, 3)).toEqual(['Library health scan', 'iCloud', 'Job 9']);
    expect(items.some(({ title }) => title === 'Render')).toBe(false);
  });

  it('names a job about a Locked item generically', () => {
    const [item] = recentUtilityActivity([
      operation(1, { kind: MediaOperationKind.MediaHealth, withheld: true, label: 'secret.jpg' } as never),
    ]);
    expect(item.titleKey).toBe('frameleaf_activity_title_locked_item');
  });
});
