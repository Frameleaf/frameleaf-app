import {
  ClassificationPreviewDto,
  ClassificationRuleCreateDto,
  ClassificationRuleUpdateDto,
} from 'src/dtos/classification.dto.js';

it('preserves the shared scope/color query through smart-album create, preview and update', () => {
  const filter = { libraryScope: 'design', color: { hex: '#609060', tolerance: 'normal', minWeight: 0.05 } };
  expect(ClassificationRuleCreateDto.schema.parse({ albumName: 'Green references', filter })).toHaveProperty(
    'filter',
    filter,
  );
  expect(ClassificationPreviewDto.schema.parse({ filter })).toHaveProperty('filter', filter);
  expect(ClassificationRuleUpdateDto.schema.parse({ filter: null })).toHaveProperty('filter', null);
});
