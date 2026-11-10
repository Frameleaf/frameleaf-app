import { FileProblemDto, FileProblemPageDto, FileProblemRowDto } from 'src/dtos/file-problem.dto.js';
import { LostOriginalsResponseDto } from 'src/dtos/lost-originals.dto.js';
import { MediaHealthCategory } from 'src/enum.js';

// An imported photo or account keeps the id it is given, which need not be a v4 UUID (CodeRabbit on PR #989).
const v7 = '01937f5e-6a2b-7c3d-8e4f-0123456789ab';
const problemId = '74fdc18d-759c-4b7d-af89-eeb4e0054363';

const row = {
  id: problemId,
  assetId: v7,
  ownerId: v7,
  ownerName: 'Ana',
  originalFileName: 'IMG_0001.jpg',
  category: MediaHealthCategory.Corrupt,
  fixState: 'repaired',
  partSaved: false,
  line: { step: 'repaired', outcome: 'ok', facts: {} },
  updatedAt: '2026-11-10T08:00:00.000Z',
  pictureAllowed: true,
  canAct: true,
};

describe('file problem responses', () => {
  it('accept a photo and an owner whose ids are v7 UUIDs', () => {
    expect(FileProblemRowDto.schema.safeParse(row).success).toBe(true);
    expect(FileProblemPageDto.schema.safeParse({ items: [row], total: 1 }).success).toBe(true);
    expect(
      FileProblemDto.schema.safeParse({
        ...row,
        steps: [{ at: '2026-11-10T08:00:00.000Z', step: 'imported', outcome: 'failed', facts: {} }],
      }).success,
    ).toBe(true);
  });

  it('still refuse an id that is not a UUID', () => {
    expect(FileProblemRowDto.schema.safeParse({ ...row, assetId: 'asset-1' }).success).toBe(false);
    expect(FileProblemRowDto.schema.safeParse({ ...row, ownerId: 'user-1' }).success).toBe(false);
  });
});

describe('lost originals response', () => {
  it('accepts a photo whose id is a v7 UUID', () => {
    const item = {
      assetId: v7,
      checksum: 'ZmFrZS1zaGEx',
      originalFileName: 'IMG_0001.jpg',
      fileCreatedAt: '2026-11-10T08:00:00.000Z',
      fileSize: null,
    };
    expect(LostOriginalsResponseDto.schema.safeParse({ items: [item], hasNextPage: false }).success).toBe(true);
    expect(
      LostOriginalsResponseDto.schema.safeParse({ items: [{ ...item, assetId: 'asset-1' }], hasNextPage: false })
        .success,
    ).toBe(false);
  });

  it('carries the file size in bytes when it is known (FL-1347)', () => {
    const item = {
      assetId: v7,
      checksum: 'ZmFrZS1zaGEx',
      originalFileName: 'IMG_0001.jpg',
      fileCreatedAt: '2026-11-10T08:00:00.000Z',
      fileSize: 3_221_225_472,
    };
    expect(LostOriginalsResponseDto.schema.safeParse({ items: [item], hasNextPage: false }).success).toBe(true);
    expect(
      LostOriginalsResponseDto.schema.safeParse({ items: [{ ...item, fileSize: -1 }], hasNextPage: false }).success,
    ).toBe(false);
  });
});
