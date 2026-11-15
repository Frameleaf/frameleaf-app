import { createZodDto } from 'nestjs-zod';
import z from 'zod';

/** FL-846: moving photos from one album to another, and handing an album to someone else. */

const AlbumMoveAssetsSchema = z
  .object({
    targetAlbumId: z
      .uuidv4()
      .describe('The album the photos and videos move to. It must be an album, not a collection or shared space.'),
    assetIds: z.array(z.uuidv4()).min(1).describe('Photos and videos to move out of this album'),
  })
  .meta({ id: 'AlbumMoveAssetsDto' });

const AlbumTransferSchema = z
  .object({
    userId: z
      .uuidv4()
      .describe('The new owner: someone already in the album, or a partner you share your library with'),
  })
  .meta({ id: 'AlbumTransferDto' });

export class AlbumMoveAssetsDto extends createZodDto(AlbumMoveAssetsSchema) {}
export class AlbumTransferDto extends createZodDto(AlbumTransferSchema) {}
