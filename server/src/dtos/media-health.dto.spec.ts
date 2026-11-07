import { MediaHealthRepairPreviewDto } from 'src/dtos/media-health.dto.js';

const findingId = '74fdc18d-759c-4b7d-af89-eeb4e0054363';
const assetId = '56a26ae7-f177-4248-90bd-822197bc54a4';

it('previews a repair from exactly one of a finding or a photo', () => {
  expect(MediaHealthRepairPreviewDto.schema.safeParse({ findingId }).success).toBe(true);
  expect(MediaHealthRepairPreviewDto.schema.safeParse({ assetId }).success).toBe(true);
  expect(MediaHealthRepairPreviewDto.schema.safeParse({}).success).toBe(false);
  expect(MediaHealthRepairPreviewDto.schema.safeParse({ findingId, assetId }).success).toBe(false);
});
