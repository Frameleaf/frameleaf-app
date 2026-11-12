import { DateFindingCause } from '@frameleaf/sdk';
import { canUndo, dateFixCards, shiftWords, stripTime } from '$lib/frameleaf/date-doctor';

describe('Date & Time Doctor words (FL-943)', () => {
  it('reads each side of a daylight-saving change with the zone name that side has', () => {
    // 8 March 2026, 2 AM: Edmonton goes from MST to MDT
    expect(
      stripTime({ date: '2026-03-08T08:30:00.000Z', zone: 'America/Edmonton', local: '2026-03-08T01:30:00' }, 'en'),
    ).toMatch(/^Mar 8, 2026, 1:30\sAM MST$/);
    expect(
      stripTime({ date: '2026-03-08T09:30:00.000Z', zone: 'America/Edmonton', local: '2026-03-08T03:30:00' }, 'en'),
    ).toMatch(/^Mar 8, 2026, 3:30\sAM MDT$/);
    expect(stripTime({ date: '2026-03-08T09:30:00.000Z', zone: null, local: '2026-03-08T03:30:00' }, 'en')).toMatch(
      /^Mar 8, 2026, 3:30\sAM$/,
    );
  });

  it('says a shift in hours and minutes', () => {
    expect(shiftWords(-420, 'en')).toBe('7 hours');
    expect(shiftWords(90, 'en')).toBe('1 hour, 30 minutes');
  });

  it('keeps causes, cameras and shifts apart, and a photo with no proposal makes its card unfixable', () => {
    const finding = (
      assetId: string,
      cause: DateFindingCause,
      proposedDate: string | null,
      proposedZone: string | null,
    ) => ({
      assetId,
      cause,
      confidence: 1,
      currentDate: '2026-08-12T22:00:00.000Z',
      currentZone: null,
      proposedDate,
      proposedZone,
    });
    const cards = dateFixCards([
      {
        groupKey: 'Sony|2026-08-12',
        camera: 'Sony',
        day: '2026-08-12',
        findings: [
          finding('a', DateFindingCause.BurstDrift, '2026-08-12T15:00:00.000Z', null),
          finding('b', DateFindingCause.BurstDrift, '2026-08-12T15:00:00.000Z', null),
          finding('c', DateFindingCause.BurstDrift, '2026-08-12T21:00:00.000Z', null),
          finding('d', DateFindingCause.MissingZone, '2026-08-12T22:00:00.000Z', 'America/Edmonton'),
          finding('e', DateFindingCause.EpochDate, null, null),
          // one reset date with a date in its name can be fixed, though the other can't
          finding('f', DateFindingCause.EpochDate, '2019-07-04T12:00:00.000Z', null),
        ],
      },
    ]);
    expect(cards.map((card) => [card.cause, card.findings.length, card.shiftMinutes, card.fixable])).toEqual([
      [DateFindingCause.BurstDrift, 2, -420, true],
      [DateFindingCause.BurstDrift, 1, -60, true],
      [DateFindingCause.EpochDate, 1, null, true],
      [DateFindingCause.MissingZone, 1, null, true],
      [DateFindingCause.EpochDate, 1, null, false],
    ]);
    expect(cards.find((card) => card.cause === DateFindingCause.MissingZone)).toMatchObject({
      zone: 'America/Edmonton',
      zoneChoice: true,
      keepWallTime: true,
    });
  });

  it('offers Undo until the fix is undone or 30 days have passed', () => {
    const batch = {
      id: 'b',
      cause: null,
      count: 1,
      createdAt: '2026-11-01T00:00:00.000Z',
      expiresAt: '2026-12-01T00:00:00.000Z',
      shiftMinutes: null,
      timeZone: null,
      undoneAt: null,
    };
    expect(canUndo(batch, Date.parse('2026-11-30T00:00:00.000Z'))).toBe(true);
    expect(canUndo(batch, Date.parse('2026-12-02T00:00:00.000Z'))).toBe(false);
    expect(canUndo({ ...batch, undoneAt: '2026-11-02T00:00:00.000Z' }, Date.parse('2026-11-03T00:00:00.000Z'))).toBe(
      false,
    );
  });
});
