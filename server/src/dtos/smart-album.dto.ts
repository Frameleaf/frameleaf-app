import { createZodDto } from 'nestjs-zod';
import z from 'zod';

/** FL-522: one of the person's own smart albums, as they see it. */
const MySmartAlbumSchema = z
  .object({
    kind: z.string().describe('The built-in album: pets, food, travel and so on'),
    name: z.string(),
    albumId: z.uuidv4(),
    count: z.int().nonnegative().describe('Photos and videos in it that this person can see'),
    samples: z.array(z.uuidv4()).describe('A few of the newest, to show as small pictures'),
    hidden: z.boolean().describe('This person hid it from their library; it keeps filling'),
  })
  .meta({ id: 'MySmartAlbumDto' });

const MySmartAlbumsResponseSchema = z
  .object({
    enabled: z.boolean().describe('Smart albums are on for this server'),
    albums: z.array(MySmartAlbumSchema),
  })
  .meta({ id: 'MySmartAlbumsResponseDto' });

const SmartAlbumKindParamSchema = z.object({ kind: z.string().min(1).max(64) }).meta({ id: 'SmartAlbumKindParamDto' });

const SmartAlbumHiddenSchema = z
  .object({ hidden: z.boolean().describe('Hide the album from your own library, or show it again') })
  .meta({ id: 'SmartAlbumHiddenDto' });

/** FL-522: an administrator's view of one album across the household, with their own samples. */
const SmartAlbumOverviewItemSchema = z
  .object({
    kind: z.string(),
    count: z.int().nonnegative().describe('Photos held across the household, each counted once'),
    people: z.int().nonnegative().describe('People whose album holds at least one photo'),
    hiddenBy: z.int().nonnegative().describe('People who hid it from their library'),
    samples: z.array(z.uuidv4()).describe('A few of the newest from the administrator’s own album'),
  })
  .meta({ id: 'SmartAlbumOverviewItemDto' });

const SmartAlbumOverviewResponseSchema = z
  .object({
    people: z.int().nonnegative().describe('People on this server'),
    albums: z.array(SmartAlbumOverviewItemSchema),
  })
  .meta({ id: 'SmartAlbumOverviewResponseDto' });

const SmartAlbumPreviewSchema = z
  .object({
    kind: z.string().min(1).max(64),
    tagTriggers: z.array(z.string().max(200)).max(200).describe('Words: a photo whose tags include one joins'),
    clipQueries: z.array(z.string().max(200)).max(50).describe('Phrases: a photo that looks like one joins'),
    threshold: z.number().min(0).max(1).meta({ format: 'double' }).describe('How alike a photo must look'),
  })
  .meta({ id: 'SmartAlbumPreviewDto' });

const SmartAlbumPreviewResponseSchema = z
  .object({
    current: z.int().nonnegative().describe('Photos in your album now'),
    matched: z.int().nonnegative().describe('Photos in your library the rule would hold'),
    adds: z.int().nonnegative().describe('Photos the change would add'),
    removes: z.int().nonnegative().describe('Photos the change would take out'),
    addSamples: z.array(z.uuidv4()),
    removeSamples: z.array(z.uuidv4()),
    looksChecked: z
      .boolean()
      .describe(
        'False when the phrases could not be compared (Visual search off or not answering): only words were used',
      ),
  })
  .meta({ id: 'SmartAlbumPreviewResponseDto' });

export class MySmartAlbumsResponseDto extends createZodDto(MySmartAlbumsResponseSchema) {}
export class SmartAlbumKindParamDto extends createZodDto(SmartAlbumKindParamSchema) {}
export class SmartAlbumHiddenDto extends createZodDto(SmartAlbumHiddenSchema) {}
export class SmartAlbumOverviewResponseDto extends createZodDto(SmartAlbumOverviewResponseSchema) {}
export class SmartAlbumPreviewDto extends createZodDto(SmartAlbumPreviewSchema) {}
export class SmartAlbumPreviewResponseDto extends createZodDto(SmartAlbumPreviewResponseSchema) {}
