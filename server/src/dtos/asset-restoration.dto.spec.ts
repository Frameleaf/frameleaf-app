import { describe, expect, it } from 'vitest';
import {
  AssetRestorationFileKind,
  AssetRestorationFileQueryDto,
  AssetRestorationMode,
  AssetRestorationOptionsQueryDto,
  AssetRestorationRegionSchema,
  AssetRestorationRequestDto,
  AssetRestorationSelectDto,
  DEFAULT_RESTORATION_REGION,
} from 'src/dtos/asset-restoration.dto.js';

const destinationId = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

describe('AssetRestorationRequestDto', () => {
  it('requires an explicit destination and fills the defaults', () => {
    const result = AssetRestorationRequestDto.schema.safeParse({ mode: AssetRestorationMode.Faithful, destinationId });
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ upscale: 2, keepGrain: false, region: DEFAULT_RESTORATION_REGION });

    expect(AssetRestorationRequestDto.schema.safeParse({ mode: AssetRestorationMode.Faithful }).success).toBe(false);
    expect(
      AssetRestorationRequestDto.schema.safeParse({ mode: AssetRestorationMode.Faithful, destinationId: 'local' })
        .success,
    ).toBe(false);
  });

  it('accepts only the three upscale factors', () => {
    for (const upscale of [1, 2, 4]) {
      expect(AssetRestorationRequestDto.schema.safeParse({ mode: 'creative', destinationId, upscale }).success).toBe(
        true,
      );
    }
    expect(AssetRestorationRequestDto.schema.safeParse({ mode: 'creative', destinationId, upscale: 3 }).success).toBe(
      false,
    );
    expect(AssetRestorationRequestDto.schema.safeParse({ mode: 'creative', destinationId, upscale: 8 }).success).toBe(
      false,
    );
  });

  it('keeps the preview region inside the frame and not too small', () => {
    expect(AssetRestorationRegionSchema.safeParse({ x: 0, y: 0, w: 1, h: 1 }).success).toBe(true);
    expect(AssetRestorationRegionSchema.safeParse({ x: 0.6, y: 0, w: 0.5, h: 1 }).success).toBe(false);
    expect(AssetRestorationRegionSchema.safeParse({ x: 0, y: 0, w: 0.05, h: 1 }).success).toBe(false);
    expect(AssetRestorationRegionSchema.safeParse({ x: 0, y: 0, w: 1, h: 1, startSeconds: -1 }).success).toBe(false);
    expect(AssetRestorationRegionSchema.safeParse({ x: 0, y: 0, w: 1, h: 1, startSeconds: 12.5 }).success).toBe(true);
  });
});

describe('AssetRestorationOptionsQueryDto', () => {
  it('coerces the upscale from the query string and refuses unknown factors', () => {
    expect(AssetRestorationOptionsQueryDto.schema.safeParse({ upscale: '4' }).data).toMatchObject({ upscale: 4 });
    expect(AssetRestorationOptionsQueryDto.schema.safeParse({ upscale: '3' }).success).toBe(false);
    expect(AssetRestorationOptionsQueryDto.schema.safeParse({}).success).toBe(true);
  });
});

describe('AssetRestorationSelectDto and file query', () => {
  it('lets the original be chosen by naming nothing, and defaults the file kind to the restored preview', () => {
    expect(AssetRestorationSelectDto.schema.safeParse({}).success).toBe(true);
    expect(AssetRestorationSelectDto.schema.safeParse({ restorationId: destinationId }).success).toBe(false);
    expect(
      AssetRestorationSelectDto.schema.safeParse({ restorationId: '0195e2a0-0000-7000-8000-000000000001' }).success,
    ).toBe(true);
    expect(AssetRestorationFileQueryDto.schema.safeParse({}).data).toEqual({ kind: AssetRestorationFileKind.After });
  });
});
