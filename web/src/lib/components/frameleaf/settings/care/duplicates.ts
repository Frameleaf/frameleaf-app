/**
 * "How alike they must be" on Library care › Duplicates (FL-366): three choices that write the one
 * number the server keeps (`machineLearning.duplicateDetection.maxDistance`, 0.001 to 0.1, lower is
 * stricter). Balanced is the server's default, 0.01 (`server/src/dtos/config.dto.ts`); the other two
 * are the approved prototype's (`settings-v2/care/duplicates.jsx`). A saved number that matches none
 * of them is "Custom" and is left alone until a choice replaces it.
 */
export type AlikeChoice = 'close' | 'balanced' | 'loose';

export const ALIKE_CHOICES: readonly { id: AlikeChoice; maxDistance: number }[] = [
  { id: 'close', maxDistance: 0.004 },
  { id: 'balanced', maxDistance: 0.01 },
  { id: 'loose', maxDistance: 0.03 },
];

/**
 * FL-520: how long comparing again takes, as said on the page: "about 40 minutes", "about 3 hours".
 * Returns the translation key and its values.
 */
export const aboutDuration = (seconds: number) => {
  const minutes = Math.max(1, Math.round(seconds / 60));
  return minutes < 90
    ? { key: 'frameleaf_dupes_about_minutes' as const, values: { count: minutes } }
    : { key: 'frameleaf_dupes_about_hours' as const, values: { count: Math.round(minutes / 60) } };
};

export const alikeChoiceOf = (maxDistance: number): AlikeChoice | 'custom' =>
  ALIKE_CHOICES.find((choice) => Math.abs(choice.maxDistance - maxDistance) < 1e-9)?.id ?? 'custom';

/**
 * FL-651: how different two videos' pictures may look and still match, said in words. The server
 * keeps a number from 0 to 16 (`enhancedVideo.maxHashDistance`, 8 by default); nobody needs to see
 * it. Each choice covers the numbers up to its `most`.
 */
export type VideoLook = 'very_strict' | 'strict' | 'balanced' | 'loose' | 'very_loose';

const VIDEO_LOOKS: readonly { id: VideoLook; most: number }[] = [
  { id: 'very_strict', most: 2 },
  { id: 'strict', most: 6 },
  { id: 'balanced', most: 9 },
  { id: 'loose', most: 12 },
  { id: 'very_loose', most: 16 },
];

export const videoLookOf = (maxHashDistance: number): VideoLook =>
  (VIDEO_LOOKS.find((look) => maxHashDistance <= look.most) ?? VIDEO_LOOKS.at(-1)!).id;
