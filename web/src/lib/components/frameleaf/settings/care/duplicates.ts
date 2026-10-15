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

export const alikeChoiceOf = (maxDistance: number): AlikeChoice | 'custom' =>
  ALIKE_CHOICES.find((choice) => Math.abs(choice.maxDistance - maxDistance) < 1e-9)?.id ?? 'custom';
