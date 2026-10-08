import { MediaOperationStatus } from '@frameleaf/sdk';
import { describe, expect, it } from 'vitest';
import {
  groupStudioByDay,
  rememberStudioOpening,
  studioDaysAgo,
  studioDockClearance,
  studioExportJobPhase,
  studioExportPercent,
  studioProjectSharedKey,
  studioRelativeTime,
  studioTimecode,
  takeStudioOpening,
} from './chrome';

describe('Studio chrome rules', () => {
  it('writes a comment time as a clock', () => {
    expect(studioTimecode(null)).toBe('00:00');
    expect(studioTimecode({ num: 12_345, den: 1000 })).toBe('00:12');
    expect(studioTimecode({ num: 125, den: 1 })).toBe('02:05');
    expect(studioTimecode({ num: 3723, den: 1 })).toBe('1:02:03');
    expect(studioTimecode({ num: -5, den: 1 })).toBe('00:00');
  });

  it('groups a newest-first list by calendar day and keeps its order', () => {
    const now = new Date(2026, 9, 8, 15, 0);
    const items = [
      { id: 4, at: new Date(2026, 9, 8, 14, 2) },
      { id: 3, at: new Date(2026, 9, 8, 9, 30) },
      { id: 2, at: new Date(2026, 9, 7, 23, 59) },
      { id: 1, at: new Date(2026, 8, 30, 12, 0) },
    ];
    const groups = groupStudioByDay(items, (item) => item.at, now);
    expect(groups.map((group) => [group.daysAgo, group.items.map((item) => item.id)])).toEqual([
      [0, [4, 3]],
      [1, [2]],
      [8, [1]],
    ]);
    expect(studioDaysAgo(new Date(2026, 9, 7, 23, 59), new Date(2026, 9, 8, 0, 1))).toBe(1);
  });

  it('says how long ago a project was edited', () => {
    const now = new Date('2026-10-08T12:00:00Z');
    expect(studioRelativeTime('2026-10-05T12:00:00Z', 'en', now)).toBe('3 days ago');
    expect(studioRelativeTime('2026-10-08T10:00:00Z', 'en', now)).toBe('2 hours ago');
    expect(studioRelativeTime('2026-10-08T11:59:50Z', 'en', now)).toBe('now');
  });

  it('hands the opened card to the editor once, and only for that project', () => {
    rememberStudioOpening({ projectId: 'p-1', name: 'Lake trip', posterUrl: '/poster' });
    expect(takeStudioOpening('p-2')).toBeNull();
    rememberStudioOpening({ projectId: 'p-1', name: 'Lake trip', posterUrl: '/poster' });
    expect(takeStudioOpening('p-1')).toEqual({ projectId: 'p-1', name: 'Lake trip', posterUrl: '/poster' });
    expect(takeStudioOpening('p-1')).toBeNull();
  });

  it('reads an export job as waiting, working, ready or failed', () => {
    expect(studioExportJobPhase({ status: MediaOperationStatus.Queued })).toBe('queued');
    expect(studioExportJobPhase({ status: MediaOperationStatus.Rendering })).toBe('working');
    expect(studioExportJobPhase({ status: MediaOperationStatus.Validating })).toBe('working');
    expect(studioExportJobPhase({ status: MediaOperationStatus.Completed })).toBe('ready');
    expect(studioExportJobPhase({ status: MediaOperationStatus.Cancelled })).toBe('failed');
    expect(studioExportPercent({ progress: 41.6 })).toBe(42);
    expect(studioExportPercent({ progress: 140 })).toBe(100);
  });

  it('names a project poster the same on its card and on the opening screen', () => {
    expect(studioProjectSharedKey('p-1')).toBe('studio-project:p-1');
  });

  describe('keeping the transfer dock off the chrome', () => {
    const base = {
      viewportHeight: 900,
      stretched: false,
      hostBottom: 900,
      drawerWidth: 0,
      panelReach: 0,
      footTop: null,
    };

    it('asks for nothing while no drawer or preview is open', () => {
      expect(studioDockClearance(base)).toEqual({ right: 0, clearance: 0 });
    });

    it('steps the dock beside an open drawer', () => {
      expect(studioDockClearance({ ...base, drawerWidth: 352, footTop: 780 })).toEqual({ right: 352, clearance: 0 });
    });

    it('raises the dock above the server preview, with the gap the preview keeps', () => {
      expect(studioDockClearance({ ...base, panelReach: 260 })).toEqual({ right: 0, clearance: 276 });
      expect(studioDockClearance({ ...base, hostBottom: 880, panelReach: 260 }).clearance).toBe(296);
    });

    it('raises the dock above the comment field when it spans a narrow window', () => {
      expect(
        studioDockClearance({
          ...base,
          viewportHeight: 800,
          hostBottom: 800,
          stretched: true,
          drawerWidth: 390,
          footTop: 660,
        }),
      ).toEqual({ right: 0, clearance: 156 });
      expect(studioDockClearance({ ...base, stretched: true, drawerWidth: 390 }).clearance).toBe(0);
    });
  });
});
