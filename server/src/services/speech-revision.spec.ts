import { SpeechSettingsUpdateDto } from 'src/dtos/speech.dto.js';

it('requires an explicit last-seen generation even for an opt-in update', () => {
  expect(
    SpeechSettingsUpdateDto.schema.safeParse({ enabled: true, scope: 'library', albumIds: [], destinationId: null })
      .success,
  ).toBe(false);
  expect(
    SpeechSettingsUpdateDto.schema.safeParse({
      expectedGeneration: null,
      enabled: false,
      scope: 'library',
      albumIds: [],
      destinationId: null,
    }).success,
  ).toBe(true);
});
