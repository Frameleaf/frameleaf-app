import z from 'zod';

/** The native Qwen binding's request and result task (FD-31). */
export const DESCRIPTION_TASK = 'image-description-tagging';

// The native binding returns one factual sentence and leaves every other field empty.
const schema = z.strictObject({
  [DESCRIPTION_TASK]: z.strictObject({
    description: z
      .string()
      .min(1)
      .max(240)
      .refine((value) => value.trim() === value && !/\p{Cc}/u.test(value) && !/<\s*\/?\s*think\b/i.test(value)),
    people: z.tuple([]),
    environment: z.literal(''),
    objects: z.tuple([]),
    visible_text: z.tuple([]),
    context: z.literal(''),
    tags: z.tuple([]),
  }),
});

/** A desktop's description: one bounded sentence, nothing else (FD-31). */
export const parseBoundDescriptionResult = (value: unknown) => schema.parse(value);
