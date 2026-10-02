import { describe, expect, it } from 'vitest';
import { computeDifferingMetadataFields, getAllMetadataItems } from '$lib/utils/duplicate-utils';
import { assetFactory } from '@test-data/factories/asset-factory';

describe('duplicate EXIF rejection comparison', () => {
  it('displays rejection and distinguishes it from stars', () => {
    const rejected = assetFactory.build({ exifInfo: { rating: null, isRejected: true } });
    const translate = ((key: string) => key) as Parameters<typeof getAllMetadataItems>[1];
    expect(
      getAllMetadataItems(rejected, translate, 'en').find((item) => [...item.keys].includes('rating'))?.render,
    ).toBe('frameleaf_library_rating_rejected');
    const stars = assetFactory.build({ exifInfo: { rating: 3, isRejected: false } });
    expect(computeDifferingMetadataFields([rejected, stars]).rating).toBe(true);
    const legacy = assetFactory.build({ exifInfo: { rating: -1 } });
    expect(computeDifferingMetadataFields([rejected, legacy]).rating).toBe(false);
  });
});
