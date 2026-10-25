import z from 'zod';
import { MediaHealthStatus } from 'src/enum.js';
import { sourceReferenceSchema } from 'src/utils/source-reference.js';

const rawUnsupportedMessages = [
  'Input file has corrupt header',
  'Input buffer contains unsupported image format',
  'Unsupported file format or not RAW file',
  'unsupported image format',
  'no decode delegate',
];

const corruptMessages = ['corrupt', 'invalid', 'premature end', 'truncated', 'damaged'];

export const getErrorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const isUnsupportedRawDecodeError = (error: unknown) => {
  const message = getErrorMessage(error);
  return rawUnsupportedMessages.some((item) => message.includes(item));
};

export const classifyImageDecodeFailure = (
  error: unknown,
  options: { isRaw: boolean; enhancedRawAttempted?: boolean },
): MediaHealthStatus => {
  const message = getErrorMessage(error).toLowerCase();

  if (options.isRaw && isUnsupportedRawDecodeError(error)) {
    return MediaHealthStatus.UnsupportedRaw;
  }

  if (corruptMessages.some((item) => message.includes(item))) {
    return options.isRaw ? MediaHealthStatus.CorruptSuspect : MediaHealthStatus.CorruptConfirmed;
  }

  return MediaHealthStatus.CorruptSuspect;
};

export const healthSourceReviewSchema = sourceReferenceSchema;
export type HealthSourceReview = z.infer<typeof healthSourceReviewSchema>;

export const sameHealthSourceReview = (left: unknown, right: unknown): boolean => {
  const a = healthSourceReviewSchema.safeParse(left);
  const b = healthSourceReviewSchema.safeParse(right);
  return (
    a.success &&
    b.success &&
    a.data.resourceId === b.data.resourceId &&
    a.data.version === b.data.version &&
    a.data.sha256 === b.data.sha256
  );
};

export const healthSourceTrashIntentSchema = z
  .object({
    ownerId: z.uuid(),
    confirmationId: z.uuid(),
    source: healthSourceReviewSchema,
  })
  .strict();
export type HealthSourceTrashIntent = z.infer<typeof healthSourceTrashIntentSchema>;

export const sameHealthSourceTrashIntent = (left: unknown, right: unknown): boolean => {
  const a = healthSourceTrashIntentSchema.safeParse(left);
  const b = healthSourceTrashIntentSchema.safeParse(right);
  return (
    a.success &&
    b.success &&
    a.data.ownerId === b.data.ownerId &&
    a.data.confirmationId === b.data.confirmationId &&
    sameHealthSourceReview(a.data.source, b.data.source)
  );
};
