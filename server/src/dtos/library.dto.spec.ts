import { CreateLibraryDto, UpdateLibraryDto } from 'src/dtos/library.dto.js';

const ownerId = '11111111-1111-4111-8111-111111111111';

describe('library read-only policy', () => {
  it('accepts an explicit boolean on creation', () => {
    expect(CreateLibraryDto.schema.parse({ ownerId, readOnly: true })).toMatchObject({ readOnly: true });
    expect(CreateLibraryDto.schema.safeParse({ ownerId, readOnly: 'true' }).success).toBe(false);
  });

  it('preserves omitted legacy input and grants no update authority', () => {
    expect(CreateLibraryDto.schema.parse({ ownerId })).not.toHaveProperty('readOnly');
    expect(UpdateLibraryDto.schema.parse({ readOnly: false })).not.toHaveProperty('readOnly');
  });
});
