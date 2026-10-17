import { splitSearchMatch } from './string-utils';

it('reuses grapheme segmentation within a locale and refreshes it when the chosen locale changes', () => {
  splitSearchMatch('Café', 'cafe', 'de');
  const NativeSegmenter = Intl.Segmenter;
  const languages: unknown[] = [];
  const constructor = vi.spyOn(Intl, 'Segmenter').mockImplementation(
    class extends NativeSegmenter {
      constructor(...args: ConstructorParameters<typeof NativeSegmenter>) {
        super(...args);
        languages.push(args[0]);
      }
    },
  );
  try {
    for (const language of ['fr', 'fr', 'ja']) {
      expect(splitSearchMatch('Cafe\u{301}', 'café', language)).toEqual(['', 'Cafe\u{301}', '']);
    }
    expect(languages).toEqual(['fr', 'ja']);
  } finally {
    constructor.mockRestore();
  }
});
