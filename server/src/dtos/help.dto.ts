import { createZodDto } from 'nestjs-zod';
import z from 'zod';

/**
 * In-app help (FL-488): the frameleaf.app help articles and Ask Frameleaf, relayed by this server.
 * The article index is the website's `/help-index.json` (FL-487); the shapes below validate it on
 * arrival and describe it to clients.
 */
const HelpHeadingSchema = z
  .object({
    title: z.string(),
    text: z.string().describe('The opening paragraph of the section, as plain text'),
  })
  .meta({ id: 'HelpHeadingDto' });

export const HelpArticleSchema = z
  .object({
    id: z
      .string()
      .regex(/^[a-z0-9-]+\/[a-z0-9-]+$/)
      .describe('The guide, such as using/sharing'),
    url: z
      .string()
      .regex(/^\/docs\/[a-z0-9/-]+\/$/)
      .describe('Path of the guide on the help website'),
    section: z.string(),
    sectionTitle: z.string(),
    title: z.string(),
    description: z.string(),
    appScreens: z.array(z.string()).describe('App screens this guide helps on, most useful guides first'),
    intro: z.string().describe('The opening paragraph, as plain text'),
    headings: z.array(HelpHeadingSchema),
    text: z.string().describe('Plain text of the guide for searching, possibly shortened'),
  })
  .meta({ id: 'HelpArticleDto' });

/** The website's index as it arrives; anything else is refused and the last good copy kept. */
export const HelpIndexSchema = z.object({
  format: z.literal(1),
  source: z.string(),
  builtAt: z.string(),
  screens: z.array(z.string()),
  articles: z.array(HelpArticleSchema).min(1),
});
export type HelpIndex = z.infer<typeof HelpIndexSchema>;

const HelpIndexResponseSchema = z
  .object({
    origin: z.string().describe('The help website, such as https://frameleaf.app'),
    builtAt: z.string().describe('When the website built this index'),
    updatedAt: z.string().nullable().describe('When this server last fetched it; null for the copy in the image'),
    offline: z.boolean().describe('The last attempt to reach the help website failed'),
    screens: z.array(z.string()).describe('Every app screen key the website knows'),
    articles: z.array(HelpArticleSchema),
    ask: z
      .object({
        enabled: z.boolean().describe('Ask Frameleaf is on (help.askEnabled)'),
        hardware: z
          .string()
          .nullable()
          .describe('The hardware answers take into account, as shown to people, or null when unknown'),
      })
      .meta({ id: 'HelpAskStatusDto' }),
  })
  .meta({ id: 'HelpIndexResponseDto' });
export class HelpIndexResponseDto extends createZodDto(HelpIndexResponseSchema) {}

const HelpArticleResponseSchema = z
  .object({
    id: z.string(),
    url: z.string(),
    markdown: z.string().describe('The guide as Markdown, from the help website'),
  })
  .meta({ id: 'HelpArticleResponseDto' });
export class HelpArticleResponseDto extends createZodDto(HelpArticleResponseSchema) {}

const HelpAskSchema = z
  .object({
    question: z.string().trim().min(1).max(4000),
    turns: z
      .array(
        z
          .object({ role: z.enum(['user', 'assistant']).meta({ id: 'HelpAskRole' }), text: z.string().max(4000) })
          .meta({ id: 'HelpAskTurnDto' }),
      )
      .max(6)
      .default([])
      .describe('The conversation so far, oldest first'),
    screen: z.string().trim().min(1).max(80).optional().describe('The app screen the help panel was opened on'),
  })
  .meta({ id: 'HelpAskDto' });
export class HelpAskDto extends createZodDto(HelpAskSchema) {}

/** The Ask service's answer (fl-app-website `ask/types.ts` resultSchema), passed through as it is. */
export const HelpAskResultSchema = z
  .object({
    kind: z.enum(['answer', 'clarification', 'fallback']).meta({ id: 'HelpAnswerKind' }),
    blocks: z
      .array(
        z
          .object({
            text: z.string().min(1).max(3000),
            sourceIds: z.array(z.string().max(160)).max(8).describe('Sources this paragraph rests on'),
          })
          .meta({ id: 'HelpAnswerBlockDto' }),
      )
      .max(8),
    sources: z
      .array(
        z
          .object({
            id: z.string().max(160),
            title: z.string().max(200),
            url: z.string().max(300).describe('Path on the help website'),
          })
          .meta({ id: 'HelpAnswerSourceDto' }),
      )
      .max(8),
    questions: z.array(z.string().max(300)).max(3).describe('What Ask needs to know to answer better'),
  })
  .meta({ id: 'HelpAskResponseDto' });
export class HelpAskResponseDto extends createZodDto(HelpAskResultSchema) {}
