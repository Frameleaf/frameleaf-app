import { RawSupportSource, RawSupportStatus, type RawSupportItemDto, type RawSupportResponseDto } from '@frameleaf/sdk';
import {
  REPAIR_STALL_MS,
  advanceRepair,
  cameraName,
  formatRows,
  repairableIds,
  startRepair,
} from '$lib/frameleaf/raw-support';

const item = (assetId: string, value: Partial<RawSupportItemDto> = {}): RawSupportItemDto => ({
  assetId,
  fileName: `${assetId}.CR3`,
  extension: 'cr3',
  make: 'Canon',
  model: 'Canon EOS R5',
  width: 8192,
  height: 5464,
  status: RawSupportStatus.Ready,
  source: RawSupportSource.Sensor,
  hasFullsize: false,
  renderedAt: null,
  pairedFileName: null,
  ...value,
});

const summary = (items: RawSupportItemDto[]): RawSupportResponseDto =>
  ({ items, total: items.length, formats: [] }) as unknown as RawSupportResponseDto;

describe('raw-support', () => {
  it('repairs only files without a preview or whose render timed out', () => {
    expect(
      repairableIds([
        item('a', { status: RawSupportStatus.Pending }),
        item('b', { status: RawSupportStatus.Timeout }),
        item('c', { status: RawSupportStatus.Unsupported }),
        item('d'),
      ]),
    ).toEqual(['a', 'b']);
  });

  it('names a camera once, even when the model repeats the maker', () => {
    expect(cameraName({ make: 'Canon', model: 'Canon EOS R5' })).toBe('Canon EOS R5');
    expect(cameraName({ make: 'NIKON CORPORATION', model: 'Z 8' })).toBe('NIKON CORPORATION Z 8');
    expect(cameraName({ make: 'Sony', model: null })).toBe('Sony');
    expect(cameraName({ make: null, model: null })).toBe('');
  });

  it("merges the library's counts into the prototype's format rows and lists other formats after them", () => {
    const rows = formatRows([
      { extension: 'cr2', count: 2, ready: 2, attention: 0, tested: ['Canon EOS 70D'] },
      { extension: 'cr3', count: 3, ready: 1, attention: 1, tested: [] },
      { extension: 'pef', count: 1, ready: 1, attention: 0, tested: [] },
    ]);
    expect(rows[0]).toEqual({
      label: 'CR2 / CR3',
      maker: 'Canon',
      count: 5,
      ready: 3,
      attention: 1,
      tested: ['Canon EOS 70D'],
    });
    expect(rows.map((row) => row.label)).toEqual([
      'CR2 / CR3',
      'NEF',
      'ARW',
      'RAF',
      'DNG / ProRAW',
      'ORF',
      'RW2',
      'PEF',
    ]);
    expect(rows.at(-1)).toMatchObject({ maker: 'Pentax', count: 1 });
    expect(rows[1]).toMatchObject({ count: 0, tested: [] });
  });

  describe('repair progress', () => {
    const start = new Date('2026-10-16T10:00:00.000Z');
    const later = (ms: number) => new Date(start.getTime() + ms);

    it('counts a file done once its preview is newer than the repair, or once it left the list', () => {
      const repair = startRepair(['a', 'b', 'c', 'a'], start);
      expect(repair.ids).toEqual(['a', 'b', 'c']);
      const next = advanceRepair(
        repair,
        summary([
          item('a', { renderedAt: later(5000).toISOString() }),
          item('b', { renderedAt: new Date(start.getTime() - 5000).toISOString(), status: RawSupportStatus.Pending }),
        ]),
        later(6000),
      );
      expect(next).toMatchObject({ done: ['a', 'c'], status: 'running', progressAt: later(6000).toISOString() });
      const finished = advanceRepair(
        next,
        summary([item('b', { renderedAt: later(9000).toISOString() })]),
        later(10_000),
      );
      expect(finished.status).toBe('complete');
    });

    it('stops waiting when nothing finishes for a while', () => {
      const repair = startRepair(['a'], start);
      const pending = summary([item('a', { status: RawSupportStatus.Pending })]);
      expect(advanceRepair(repair, pending, later(60_000)).status).toBe('running');
      expect(advanceRepair(repair, pending, later(REPAIR_STALL_MS + 1)).status).toBe('stalled');
    });
  });
});
