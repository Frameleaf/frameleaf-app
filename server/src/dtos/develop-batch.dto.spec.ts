import { randomUUID } from 'node:crypto';
import { DevelopBatchCreateDto, DevelopBatchImportDto } from 'src/dtos/develop-batch.dto.js';

it('keeps the full selected set and permits fileless retry of an existing confirmed return', () => {
  const ids = Array.from({ length: 1200 }, () => randomUUID());
  expect(DevelopBatchCreateDto.schema.parse({ assetIds: ids }).assetIds).toEqual(ids);
  expect(
    DevelopBatchImportDto.schema.parse({ confirmationId: randomUUID(), renditionChecksum: 'a'.repeat(64) }).file,
  ).toBeUndefined();
});
