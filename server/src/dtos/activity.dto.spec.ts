import { ActivityCreateDto, ReactionType } from 'src/dtos/activity.dto.js';

const albumId = '74fdc18d-759c-4b7d-af89-eeb4e0054363';
const assetId = '56a26ae7-f177-4248-90bd-822197bc54a4';

it('keeps album-only likes and asset comments compatible', () => {
  const like = { albumId, type: ReactionType.LIKE };
  const comment = { albumId, assetId, type: ReactionType.COMMENT, comment: 'An observation' };
  expect(ActivityCreateDto.schema.parse(like)).toEqual(like);
  expect(ActivityCreateDto.schema.parse(comment)).toEqual(comment);
});

it.each([
  { albumId, assetId: 'invalid', type: ReactionType.LIKE },
  { albumId, type: ReactionType.COMMENT },
  { albumId, type: ReactionType.COMMENT, comment: ' '.repeat(3) },
  { albumId, type: ReactionType.LIKE, comment: 'Not a comment reaction' },
  { albumId: 'invalid', type: ReactionType.LIKE },
])('retains validation for %j', (dto) => {
  expect(ActivityCreateDto.schema.safeParse(dto).success).toBe(false);
});
