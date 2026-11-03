import { createZodDto } from 'nestjs-zod';
import z from 'zod';

/**
 * The languages Studio translates captions into and from (FL-641, owner decision 2026-10-29): English and
 * the ten app languages, as BCP 47 primary tags. Norwegian is Bokmål (`nb`).
 */
export const STUDIO_CAPTION_LANGUAGES = ['en', 'fr', 'es', 'de', 'it', 'pt', 'nl', 'pl', 'sv', 'da', 'nb'] as const;
export type StudioCaptionLanguage = (typeof STUDIO_CAPTION_LANGUAGES)[number];

/** At most this many lines in one request, each at most this long; the ML worker holds the same bounds. */
export const STUDIO_CAPTION_TRANSLATION_MAX_LINES = 2000;
export const STUDIO_CAPTION_TRANSLATION_MAX_LINE_CHARS = 1000;

const StudioCaptionLanguageSchema = z
  .enum(STUDIO_CAPTION_LANGUAGES)
  .describe('A language Studio translates captions into or from')
  .meta({ id: 'StudioCaptionLanguage' });

export class StudioCaptionTranslationCreateDto extends createZodDto(
  z
    .object({
      source: StudioCaptionLanguageSchema.describe('The language the captions are in'),
      target: StudioCaptionLanguageSchema.describe('The language to translate them into'),
      lines: z
        .array(z.string().max(STUDIO_CAPTION_TRANSLATION_MAX_LINE_CHARS))
        .min(1)
        .max(STUDIO_CAPTION_TRANSLATION_MAX_LINES)
        .describe('The caption lines, in order, as plain text. Timing stays with the caller.'),
    })
    .refine((value) => value.source !== value.target, { message: 'Choose another language to translate into' })
    .meta({ id: 'StudioCaptionTranslationCreateDto' }),
) {}

export class StudioCaptionTranslationDto extends createZodDto(
  z
    .object({
      source: StudioCaptionLanguageSchema,
      target: StudioCaptionLanguageSchema,
      lines: z.array(z.string()).describe('One translation per line asked for, in the same order'),
      model: z.string().describe('The translation model the worker used'),
      destinationId: z.uuid().describe('The machine-learning destination that translated the lines'),
    })
    .meta({ id: 'StudioCaptionTranslationDto' }),
) {}
