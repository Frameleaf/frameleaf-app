import { type ImportManifest } from 'src/library-import/manifest.js';
import { isQualificationRefusal } from 'src/library-import/preparation/types.js';

/**
 * Open a reader strictly when the captured schema matches its qualified fixture; otherwise (owner decision
 * FL-1149) read the same projections best effort. The caller records SOURCE_VERSION_UNTESTED.
 */
export function openSnapshotBestEffort<T>(open: (bestEffort: boolean) => T, schemaMatches: boolean) {
  if (schemaMatches) {
    try {
      return { snapshot: open(false), tested: true };
    } catch (error) {
      if (!isQualificationRefusal(error)) throw error;
    }
  }
  return { snapshot: open(true), tested: false };
}

/**
 * Readers compare the manifest source with their fixture. Best-effort reads present the fixture's identity to
 * the reader; the preparation restores the real source identity on the manifest afterwards.
 */
export const qualifiedSource = (
  source: ImportManifest['source'],
  fixture: { source: { version: string }; schemaSha256: string },
): ImportManifest['source'] => ({ ...source, version: fixture.source.version, schemaSha256: fixture.schemaSha256 });
