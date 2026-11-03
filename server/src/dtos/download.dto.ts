import { createZodDto } from 'nestjs-zod';
import z from 'zod';

const DownloadInfoSchema = z
  .object({
    assetIds: z.array(z.uuidv4()).optional().describe('Asset IDs to download'),
    albumId: z.uuidv4().optional().describe('Album ID to download'),
    userId: z.uuidv4().optional().describe('User ID to download assets from'),
    archiveSize: z.int().min(1).optional().describe('Archive size limit in bytes'),
  })
  .meta({ id: 'DownloadInfoDto' });

const DownloadArchiveInfoSchema = z
  .object({
    size: z.int().describe('Archive size in bytes'),
    assetIds: z.array(z.uuidv4()).describe('Asset IDs in this archive'),
  })
  .meta({ id: 'DownloadArchiveInfo' });

const DownloadResponseSchema = z
  .object({
    totalSize: z.int().describe('Total size in bytes'),
    archives: z.array(DownloadArchiveInfoSchema).describe('Archive information'),
  })
  .meta({ id: 'DownloadResponseDto' });

// a POST form sends booleans as the text "true" / "false"
const formBoolean = z.preprocess((val) => {
  if (val === 'true') {
    return true;
  }
  if (val === 'false') {
    return false;
  }
  return val;
}, z.boolean());

const DownloadArchiveSchema = z
  .object({
    // Support receiving assetIds as a comma-separated string due to POST form submission.
    // While we can send arrays, the total request parameter count is limited to 1000 fields,
    // which would limit this DTO to a maximum of 1000 assets.
    assetIds: z
      .preprocess((val) => (typeof val === 'string' ? val.split(',') : val), z.array(z.uuidv4()))
      .nonoptional()
      .describe('Asset IDs'),
    edited: formBoolean
      .optional()
      .describe(
        "Download each asset as it is shown: the owner's current develop version or the edited file when there is one, otherwise the original. Left out: the originals",
      ),
    includeSidecar: formBoolean
      .optional()
      .describe(
        "Put each photo's details file beside it as <file name>.xmp: its XMP sidecar, or one made from what the asset response shows the requester when it has none. Left out, the account's download.includeSidecar preference decides (shared links: no)",
      ),
    includeLibraryMetadata: formBoolean
      .optional()
      .describe(
        'Include frameleaf-library.json with owned albums, tags, bookmarks and Boards annotations alongside originals; signed-in accounts only',
      ),
    includeSources: formBoolean
      .optional()
      .describe('Explicitly include private capture attribution in the portable manifest'),
    bookmarkIds: z
      .preprocess((value) => (typeof value === 'string' ? value.split(',') : value), z.array(z.uuidv4()).max(10_000))
      .optional()
      .describe('Owned bookmarks to include in the portable manifest'),
    archiveName: z.string().optional().describe('The name of the archive to download, without extension'),
  })
  .refine(
    (value) => value.includeLibraryMetadata || (!value.includeSources && !value.bookmarkIds?.length),
    'Bookmarks and sources require a portable manifest',
  )
  .refine((value) => !value.includeLibraryMetadata || !value.edited, 'Portable library exports use originals')
  .refine(
    (value) =>
      !value.includeLibraryMetadata ||
      (value.assetIds.length <= 10_000 &&
        new Set(value.assetIds).size === value.assetIds.length &&
        new Set(value.bookmarkIds).size === (value.bookmarkIds?.length ?? 0)),
    'Portable exports require at most 10000 unique assets and bookmarks',
  )
  .meta({ id: 'DownloadArchiveDto' });

export class DownloadInfoDto extends createZodDto(DownloadInfoSchema) {}
export class DownloadResponseDto extends createZodDto(DownloadResponseSchema) {}
export class DownloadArchiveInfo extends createZodDto(DownloadArchiveInfoSchema) {}
export class DownloadArchiveDto extends createZodDto(DownloadArchiveSchema) {}
