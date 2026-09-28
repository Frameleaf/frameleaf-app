import { describe, expect, it } from 'vitest';
import {
  filterMaintenanceReportItems,
  MAINTENANCE_REPORT_QUERY_MAX_LENGTH,
  maintenanceReportFileName,
  maintenanceReportText,
  normalizeMaintenanceReportQuery,
  summarizeMaintenanceReportFilter,
} from '$lib/frameleaf/maintenance-report';

const items = [
  { id: '1', path: '/data/upload/user-1/untracked1.png' },
  { id: '2', path: '/data/upload/user-1/holiday.jpg' },
  { id: '3', path: '/data/library/user-2/2024/06/photo.heic' },
];

describe('Frameleaf maintenance report filter', () => {
  it('returns every item for an empty or whitespace-only query', () => {
    expect(filterMaintenanceReportItems(items, '')).toEqual(items);
    expect(filterMaintenanceReportItems(items, ' '.repeat(3))).toEqual(items);
    expect(filterMaintenanceReportItems(items, undefined)).toEqual(items);
    expect(filterMaintenanceReportItems(items, null)).toEqual(items);
  });

  it('matches case-insensitively on a path substring', () => {
    expect(filterMaintenanceReportItems(items, 'UNTRACKED')).toEqual([items[0]]);
    expect(filterMaintenanceReportItems(items, 'user-1')).toEqual([items[0], items[1]]);
  });

  it('trims surrounding whitespace before matching', () => {
    expect(filterMaintenanceReportItems(items, '  holiday  ')).toEqual([items[1]]);
  });

  it('returns no items when nothing matches', () => {
    expect(filterMaintenanceReportItems(items, 'does-not-exist')).toEqual([]);
  });

  it('caps the query length so a huge paste cannot blow up filtering', () => {
    const huge = 'x'.repeat(MAINTENANCE_REPORT_QUERY_MAX_LENGTH + 50);
    const normalized = normalizeMaintenanceReportQuery(huge);
    expect(normalized).toHaveLength(MAINTENANCE_REPORT_QUERY_MAX_LENGTH);
  });

  it('summarizes whether the filter narrowed the result set', () => {
    expect(summarizeMaintenanceReportFilter(3, 3)).toEqual({ filtered: 3, total: 3, isFiltered: false });
    expect(summarizeMaintenanceReportFilter(1, 3)).toEqual({ filtered: 1, total: 3, isFiltered: true });
  });
});

describe('maintenanceReportText (FL-81 CC-23, maintenance-data.mjs:657-674)', () => {
  it('writes a heading, the last run, the findings count and one path per line', () => {
    expect(
      maintenanceReportText({
        title: 'Untracked Files',
        lastRunAt: '2026-09-20T10:15:00.000Z',
        paths: ['/data/upload/a.jpg', '/data/upload/b.jpg'],
      }),
    ).toBe(
      [
        'Frameleaf integrity report · Untracked Files',
        'Last run: 2026-09-20T10:15:00.000Z',
        'Findings: 2',
        '',
        '/data/upload/a.jpg',
        '/data/upload/b.jpg',
        '',
      ].join('\n'),
    );
  });

  it('says when the check never ran', () => {
    expect(maintenanceReportText({ title: 'Missing Files', lastRunAt: null, paths: [] })).toContain('Last run: never');
  });

  it('names the file after the check and the moment', () => {
    expect(maintenanceReportFileName('missing_file', new Date('2026-09-24T17:40:05.123Z'))).toBe(
      'frameleaf-integrity-missing_file-2026-09-24-17-40-05.txt',
    );
  });
});
