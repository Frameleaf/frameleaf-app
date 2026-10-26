/**
 * Search & intelligence (FL-366): the three-step choices of the approved prototype
 * (`settings-v2/care/search.jsx`, `captions.jsx`, `albums.jsx`), each a set of the numbers or the
 * model name the server already keeps. Choosing one writes those values and nothing else; saved
 * values that match none of them are "Custom" and are left alone until a choice replaces them
 * (the pattern of `$lib/frameleaf/work-presets.ts`). The middle choice is always the server's own
 * default (`server/src/dtos/config.dto.ts`).
 */
import { QueueName, Style, type QueueResponseDto } from '@frameleaf/sdk';

export type Choice<Id extends string, Values> = { id: Id; values: Values };

/** Two numbers saved as decimals are the same choice when they agree to the hundredth. */
const same = (a: unknown, b: unknown) =>
  typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < 0.0001 : a === b;

/** The choice whose values the saved ones are, or undefined ("Custom"). */
export const choiceOf = <Id extends string, Values extends Record<string, unknown>>(
  choices: readonly Choice<Id, Values>[],
  saved: Partial<Record<keyof Values, unknown>>,
): Id | undefined =>
  choices.find((choice) => Object.entries(choice.values).every(([key, value]) => same(saved[key], value)))?.id;

/** Writes a choice's values into the draft object it describes. */
export const applyChoice = <T extends object>(target: T, values: Partial<T>) => {
  Object.assign(target, values);
};

/** Visual search quality: the search model (`machineLearning.clip.modelName`). */
export type SearchQuality = 'fast' | 'balanced' | 'best';
export const SEARCH_QUALITY: readonly Choice<SearchQuality, { modelName: string }>[] = [
  { id: 'fast', values: { modelName: 'ViT-B-32__openai' } },
  { id: 'balanced', values: { modelName: 'ViT-B-16-SigLIP-384__webli' } },
  { id: 'best', values: { modelName: 'ViT-SO400M-16-SigLIP2-384__webli' } },
];

/** How carefully faces are grouped (`machineLearning.facialRecognition`). */
export type FaceGrouping = 'careful' | 'balanced' | 'more';
export const FACE_GROUPING: readonly Choice<
  FaceGrouping,
  { maxDistance: number; minScore: number; minFaces: number }
>[] = [
  { id: 'careful', values: { maxDistance: 0.4, minScore: 0.8, minFaces: 5 } },
  { id: 'balanced', values: { maxDistance: 0.5, minScore: 0.7, minFaces: 3 } },
  { id: 'more', values: { maxDistance: 0.6, minScore: 0.5, minFaces: 2 } },
];

/** How much text is read (`machineLearning.ocr`). */
export type TextReading = 'clear' | 'balanced' | 'faint';
export const TEXT_READING: readonly Choice<TextReading, { minDetectionScore: number; minRecognitionScore: number }>[] =
  [
    { id: 'clear', values: { minDetectionScore: 0.7, minRecognitionScore: 0.9 } },
    { id: 'balanced', values: { minDetectionScore: 0.5, minRecognitionScore: 0.8 } },
    { id: 'faint', values: { minDetectionScore: 0.3, minRecognitionScore: 0.6 } },
  ];

/** "Read small print" is the detail text is read at (`machineLearning.ocr.maxResolution`). */
export const TEXT_DETAIL_NORMAL = 736;
export const TEXT_DETAIL_SMALL_PRINT = 1280;

/**
 * The text-reading models the server can load, grouped by the languages each reads. The Chinese,
 * Japanese and English group and the multilingual PP-OCRv6 group have a larger model.
 */
export type TextLanguage =
  'latin' | 'english' | 'cjk' | 'multilingual' | 'chinese_latin' | 'korean' | 'cyrillic' | 'greek' | 'thai';
export const TEXT_LANGUAGES: readonly TextLanguage[] = [
  'latin',
  'english',
  'cjk',
  'multilingual',
  'chinese_latin',
  'korean',
  'cyrillic',
  'greek',
  'thai',
];
export const TEXT_MODELS: readonly { value: string; language: TextLanguage; large?: boolean }[] = [
  { value: 'LATIN__PP-OCRv5_mobile', language: 'latin' },
  { value: 'EN__PP-OCRv5_mobile', language: 'english' },
  { value: 'PP-OCRv5_mobile', language: 'cjk' },
  { value: 'PP-OCRv5_server', language: 'cjk', large: true },
  // PP-OCRv6: one multilingual model in three sizes (upstream 3df38fe7f2); tiny reads no Japanese.
  { value: 'PP-OCRv6_small', language: 'multilingual' },
  { value: 'PP-OCRv6_medium', language: 'multilingual', large: true },
  { value: 'PP-OCRv6_tiny', language: 'chinese_latin' },
  { value: 'KOREAN__PP-OCRv5_mobile', language: 'korean' },
  { value: 'ESLAV__PP-OCRv5_mobile', language: 'cyrillic' },
  { value: 'EL__PP-OCRv5_mobile', language: 'greek' },
  { value: 'TH__PP-OCRv5_mobile', language: 'thai' },
];
export const textLanguageOf = (modelName: string) => TEXT_MODELS.find((model) => model.value === modelName)?.language;
/** The model for a language, keeping the larger one when it is chosen and the language has it. */
export const textModelFor = (language: TextLanguage, current: string) => {
  const keepLarge = TEXT_MODELS.find((model) => model.value === current)?.large;
  const models = TEXT_MODELS.filter((model) => model.language === language);
  return (models.find((model) => Boolean(model.large) === Boolean(keepLarge)) ?? models[0]).value;
};

/** How cautious Locked-content suggestions are (`machineLearning.nsfwDetection.threshold`). */
export type Caution = 'sure' | 'balanced' | 'more';
export const CAUTION: readonly Choice<Caution, { threshold: number }>[] = [
  { id: 'sure', values: { threshold: 0.95 } },
  { id: 'balanced', values: { threshold: 0.85 } },
  { id: 'more', values: { threshold: 0.7 } },
];

/** Caption length (`machineLearning.imageDescription.prompt` style and sentence count). */
export type CaptionLength = 'short' | 'medium' | 'detailed';
export const CAPTION_LENGTH: readonly Choice<CaptionLength, { style: Style; sentenceCountTarget: number }>[] = [
  { id: 'short', values: { style: Style.Terse, sentenceCountTarget: 1 } },
  { id: 'medium', values: { style: Style.Balanced, sentenceCountTarget: 3 } },
  { id: 'detailed', values: { style: Style.Rich, sentenceCountTarget: 6 } },
];

/** How many tags are suggested (`machineLearning.clip.zeroShotTagging`). */
export type TagAmount = 'few' | 'balanced' | 'more';
export const TAG_AMOUNT: readonly Choice<TagAmount, { minSimilarity: number; maxTags: number }>[] = [
  { id: 'few', values: { minSimilarity: 0.35, maxTags: 3 } },
  { id: 'balanced', values: { minSimilarity: 0.25, maxTags: 6 } },
  { id: 'more', values: { minSimilarity: 0.18, maxTags: 12 } },
];

/** How strict one smart album is (`smartAlbums.builtIn.<kind>.threshold`, 0.2 to 0.4). */
export type AlbumStrictness = 'sure' | 'balanced' | 'more';
export const ALBUM_STRICTNESS: readonly Choice<AlbumStrictness, { threshold: number }>[] = [
  { id: 'sure', values: { threshold: 0.32 } },
  { id: 'balanced', values: { threshold: 0.28 } },
  { id: 'more', values: { threshold: 0.24 } },
];

/** The kinds of background work behind each feature, for "how many are still waiting". */
export type FeatureKey =
  'smart-search' | 'faces' | 'documents' | 'descriptions' | 'sensitive-detection' | 'smart-albums';
export const FEATURE_WORK: Record<FeatureKey, readonly QueueName[]> = {
  'smart-search': [QueueName.SmartSearch],
  faces: [QueueName.FaceDetection, QueueName.FacialRecognition],
  documents: [QueueName.Ocr],
  descriptions: [QueueName.ImageDescription],
  'sensitive-detection': [QueueName.NsfwDetection],
  'smart-albums': [],
};

/** How many items of these kinds of work are running, waiting or paused (as Computers counts them). */
export const workWaiting = (queues: readonly QueueResponseDto[], names: readonly QueueName[]) =>
  queues
    .filter((queue) => names.includes(queue.name))
    .reduce((sum, { statistics }) => sum + statistics.active + statistics.waiting + statistics.paused, 0);

/** Splits a word list into the two lists a smart album keeps: single words are tags, phrases are descriptions. */
export const splitAlbumWords = (words: readonly string[]) => ({
  tagTriggers: words.filter((word) => !/\s/.test(word)),
  clipQueries: words.filter((word) => /\s/.test(word)),
});

/** A wait in whole minutes or hours, for "about 3 hours". Undefined when there is nothing to wait for. */
export const roughDuration = (seconds: number): { unit: 'minutes' | 'hours'; count: number } | undefined => {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return undefined;
  }
  if (seconds < 3600) {
    return { unit: 'minutes', count: Math.max(1, Math.round(seconds / 60)) };
  }
  return { unit: 'hours', count: Math.round(seconds / 3600) };
};
