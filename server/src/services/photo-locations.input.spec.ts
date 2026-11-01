import { randomUUID } from 'node:crypto';
import type { LocationScan, PhotoLocationsRepository } from 'src/repositories/photo-locations.repository.js';
import type { PhotoLocationPoint } from 'src/utils/photo-locations.js';
import { PhotoLocationsService } from 'src/services/photo-locations.service.js';

type InputPoint = Awaited<ReturnType<PhotoLocationsRepository['points']>>[number];

const point = (index: number, overrides?: Partial<InputPoint>): InputPoint => ({
  assetId: String(index).padStart(4, '0'),
  itemKey: `opaque-${index}`,
  originalPath: `/synthetic/${index}.jpg`,
  latitude: 49,
  longitude: -123,
  accuracyM: null,
  lockedProperties: [],
  ...overrides,
});

function setup(points: InputPoint[]) {
  const scan = { id: randomUUID(), leaseToken: randomUUID() } as LocationScan;
  const repository = {
    active: vi.fn().mockResolvedValue(true),
    points: vi.fn().mockResolvedValueOnce(points).mockResolvedValue([]),
  };
  const metadata = { readTags: vi.fn<(path: string) => Promise<Record<string, unknown>>>(), writeTags: vi.fn() };
  const service = new PhotoLocationsService(
    repository as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    metadata as never,
    { setContext: vi.fn() } as never,
    {} as never,
  );
  const input = (
    service as unknown as { inputPoints: (scan: LocationScan) => AsyncGenerator<PhotoLocationPoint> }
  ).inputPoints(scan);
  return { service, repository, metadata, scan, input };
}

it('reads legacy accuracy concurrently in groups of four and retains snapshot order', async () => {
  const points = Array.from({ length: 10 }, (_, index) => point(index));
  const { repository, metadata, scan, input } = setup(points);
  const reads = points.map(() => Promise.withResolvers<Record<string, unknown>>());
  let active = 0;
  let maximum = 0;
  metadata.readTags.mockImplementation((path) => {
    const index = points.findIndex((point) => point.originalPath === path);
    active++;
    maximum = Math.max(maximum, active);
    return reads[index].promise.finally(() => active--);
  });
  const tags = (index: number) => ({ GPSLatitude: '49', GPSLongitude: '-123', GPSHPositioningError: index + 1 });
  const output = Array.fromAsync(input);
  try {
    await vi.waitFor(() => expect(metadata.readTags).toHaveBeenCalledTimes(4));
    expect(active).toBe(4);
    for (const index of [3, 2, 1]) reads[index].resolve(tags(index));
    await vi.waitFor(() => expect(active).toBe(1));
    expect(metadata.readTags).toHaveBeenCalledTimes(4);
    reads[0].resolve(tags(0));
    await vi.waitFor(() => expect(metadata.readTags).toHaveBeenCalledTimes(8));
    for (const index of [7, 6, 5, 4]) reads[index].resolve(tags(index));
    await vi.waitFor(() => expect(metadata.readTags).toHaveBeenCalledTimes(10));
    for (const index of [9, 8]) reads[index].resolve(tags(index));

    expect(await output).toEqual(
      points.map((point, index) => ({
        itemKey: point.itemKey,
        latitude: 49,
        longitude: -123,
        accuracyM: index + 1,
      })),
    );
    expect(maximum).toBe(4);
    expect(repository.points).toHaveBeenLastCalledWith(scan, points.at(-1)!.assetId);
  } finally {
    for (const [index, read] of reads.entries()) read.resolve(tags(index));
    await output.catch(() => {});
  }
});

it('keeps known and locked accuracy out of file reads and falls back conservatively without writes', async () => {
  const points = [
    point(0, { accuracyM: 0 }),
    point(1, { lockedProperties: ['latitude'] }),
    point(2),
    point(3),
    point(4),
    point(5),
    point(6, { accuracyM: -1 }),
    point(7),
  ];
  const before = structuredClone(points);
  const { metadata, input } = setup(points);
  metadata.readTags.mockImplementation((path) => {
    const index = points.findIndex((point) => point.originalPath === path);
    if (index === 4) return Promise.reject(new Error('Unreadable synthetic file'));
    return Promise.resolve({
      GPSLatitude: index === 3 ? 50 : 49,
      GPSLongitude: index === 7 ? -122 : -123,
      GPSHPositioningError: index === 5 ? Infinity : index + 1,
    });
  });

  expect(await Array.fromAsync(input)).toEqual(
    points.map((point, index) => ({
      itemKey: point.itemKey,
      latitude: 49,
      longitude: -123,
      ...([0, 2, 6].includes(index) ? { accuracyM: index === 0 ? 0 : index + 1 } : {}),
    })),
  );
  expect(metadata.readTags.mock.calls.map(([path]) => path)).toEqual(
    points.slice(2).map((point) => point.originalPath),
  );
  expect(metadata.writeTags).not.toHaveBeenCalled();
  expect(points).toEqual(before);
});

it.each(['lease loss', 'shutdown'])('stops output and further file reads after %s during a group', async (reason) => {
  const points = Array.from({ length: 10 }, (_, index) => point(index));
  const { service, repository, metadata, input } = setup(points);
  const reads = points.map(() => Promise.withResolvers<Record<string, unknown>>());
  metadata.readTags.mockImplementation(
    (path) => reads[points.findIndex((point) => point.originalPath === path)].promise,
  );
  const emitted: PhotoLocationPoint[] = [];
  const output = Array.fromAsync(input, (point) => {
    emitted.push(point);
    return point;
  });
  try {
    await vi.waitFor(() => expect(metadata.readTags).toHaveBeenCalledTimes(4));
    if (reason === 'lease loss') repository.active.mockResolvedValue(false);
    else await service.onShutdown();
    const rejected = expect(output).rejects.toThrow(/cancelled|stopping/);
    for (const read of reads) read.resolve({ GPSLatitude: 49, GPSLongitude: -123, GPSHPositioningError: 5 });
    await rejected;
    expect(emitted).toEqual([]);
    expect(metadata.readTags).toHaveBeenCalledTimes(4);
  } finally {
    for (const read of reads) read.resolve({});
    await output.catch(() => {});
  }
});
