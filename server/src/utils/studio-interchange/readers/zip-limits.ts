/** Limits for archives editors write (FL-1546, FL-1551): they can carry media, so the archive may be large. */
import { ZipReadLimits } from 'src/utils/studio-bundle.js';

export const MAX_DOCUMENT_BYTES = 128 * 1024 * 1024;

/** Archives that carry media can be large; the project document inside is bounded. */
export const INTERCHANGE_ZIP_LIMITS: ZipReadLimits = Object.freeze({
  maxBytes: 64 * 1024 * 1024 * 1024,
  maxEntries: 20_000,
  maxDirectoryBytes: 16 * 1024 * 1024,
  maxUncompressedBytes: 128 * 1024 * 1024 * 1024,
  documentLimit: (name: string) => (/\.(?:fcpxml|otio|xml)$/i.test(name) ? MAX_DOCUMENT_BYTES : null),
  allowZip64: true,
});
