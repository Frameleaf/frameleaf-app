import { expect, it } from 'vitest';
import { toAssetResponseDto } from './rest-response';
import type { MockTimelineAsset } from './timeline-config';

const asset = (ratio: number) =>
  ({ id: 'a', ownerId: 'owner', ratio, fileCreatedAt: '2024-06-01T10:00:00.000Z' }) as unknown as MockTimelineAsset;

it.each([16 / 9, 4 / 3, 1, 3 / 4, 9 / 16])('reports exif dimensions with the asset ratio %f', (ratio) => {
  const { exifInfo } = toAssetResponseDto(asset(ratio));
  expect(exifInfo!.exifImageWidth! / exifInfo!.exifImageHeight!).toBeCloseTo(ratio, 2);
});
