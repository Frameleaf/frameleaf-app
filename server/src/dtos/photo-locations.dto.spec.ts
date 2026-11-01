import { BadRequestException } from '@nestjs/common';
import { ZodValidationPipe } from 'nestjs-zod';
import { LocationScanEstimateRequestDto, StartLocationScanDto } from 'src/dtos/photo-locations.dto.js';

it('requires an explicit positive photo or credit cap and a kept quote at confirmation', () => {
  expect(LocationScanEstimateRequestDto.schema.safeParse({}).success).toBe(false);
  for (const value of [0, -1, 1.5, Infinity]) {
    expect(LocationScanEstimateRequestDto.schema.safeParse({ maxPhotos: value }).success).toBe(false);
    expect(LocationScanEstimateRequestDto.schema.safeParse({ maxSpendMicros: value }).success).toBe(false);
  }
  expect(LocationScanEstimateRequestDto.schema.parse({ maxSpendMicros: 5_000_000 })).toEqual({
    refresh: false,
    maxSpendMicros: 5_000_000,
  });
  expect(StartLocationScanDto.schema.safeParse({ consent: true, refresh: false }).success).toBe(false);
  expect(
    StartLocationScanDto.schema.safeParse({ consent: false, estimateId: '00000000-0000-4000-8000-000000000001' })
      .success,
  ).toBe(false);
});

it.each([1, 4999])('rejects a %i microUSD cap at request validation before quoting', (maxSpendMicros) => {
  expect(() =>
    new ZodValidationPipe().transform({ maxSpendMicros }, { type: 'body', metatype: LocationScanEstimateRequestDto }),
  ).toThrow(BadRequestException);
});

it('accepts exactly one photo of credit while preserving the optional photo cap', () => {
  expect(
    new ZodValidationPipe().transform(
      { maxSpendMicros: 5000 },
      { type: 'body', metatype: LocationScanEstimateRequestDto },
    ),
  ).toEqual({ refresh: false, maxSpendMicros: 5000 });
  expect(LocationScanEstimateRequestDto.schema.parse({ maxPhotos: 1 })).toEqual({ refresh: false, maxPhotos: 1 });
});
