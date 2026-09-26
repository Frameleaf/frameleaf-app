import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { StorageCore } from 'src/cores/storage.core.js';
import { AssetType, StorageFolder } from 'src/enum.js';

/**
 * Studio export paths and settings (FL-106, `STU-404`), kept free of the database.
 *
 * A render worker writes its output into a directory the server names for that render, inside the
 * owner's private exports folder. The worker reports a path; the server accepts only a path inside
 * that directory, and at publication resolves it again with every link followed, so a worker can
 * never make somebody else's original, or any other file on the server, into a result.
 */

/** How often the publication worker looks for queued publications. */
export const STUDIO_EXPORT_TICK_MS = 5000;
/** The publication claim lease. Hashing a long video fits comfortably inside it. */
export const STUDIO_EXPORT_LEASE_MS = 10 * 60_000;
/** How often pending work is checked against its owner, project, sources and handoff state. */
export const STUDIO_EXPORT_SWEEP_MS = 60_000;
/** One attempt per claim; the automatic retry every job gets is on top of it (FL-104). */
export const STUDIO_EXPORT_PUBLISH_MAX_ATTEMPTS = 1;

const EXPORT_FOLDER = 'studio-exports';

export const studioExportRoot = (ownerId: string) =>
  join(StorageCore.getFolderLocation(StorageFolder.Exports, ownerId), EXPORT_FOLDER);

/** Where the render worker writes the output of one render. Never shared between renders. */
export const studioExportStagingFolder = (ownerId: string, renderOperationId: string) =>
  join(studioExportRoot(ownerId), 'staging', renderOperationId);

/** Where a `project` result's file lives once published. */
export const studioExportProjectPath = (ownerId: string, versionId: string, extension: string) =>
  join(studioExportRoot(ownerId), 'versions', `${versionId}${extension}`);

/** Where a `library` result's file lives once published: an ordinary upload path of the owner's. */
export const studioExportLibraryPath = (ownerId: string, versionId: string, extension: string) =>
  StorageCore.getNestedPath(StorageFolder.Upload, ownerId, `${versionId}${extension}`);

/** True when `candidate` names something strictly inside `folder`, after normalising both. */
export const isInsideFolder = (folder: string, candidate: string): boolean => {
  if (!isAbsolute(candidate)) {
    return false;
  }
  const child = relative(resolve(folder), resolve(candidate));
  return child !== '' && !child.startsWith('..') && !isAbsolute(child) && !child.split(sep).includes('..');
};

/** The containers an export may produce, and what each becomes in the library. */
export const STUDIO_EXPORT_CONTENT_TYPES: Readonly<Record<string, { extension: string; assetType: AssetType }>> = {
  'video/mp4': { extension: '.mp4', assetType: AssetType.Video },
  'video/webm': { extension: '.webm', assetType: AssetType.Video },
  'video/quicktime': { extension: '.mov', assetType: AssetType.Video },
};

export const isStudioExportContentType = (value: string): boolean => Object.hasOwn(STUDIO_EXPORT_CONTENT_TYPES, value);

/** Export formats, colour handling and resolutions offered by the Studio export dialog. */
export const STUDIO_EXPORT_FORMATS = ['mp4-hevc-main10', 'mp4-h264', 'webm-av1', 'prores-422-hq'] as const;
export const STUDIO_EXPORT_COLORS = ['preserve', 'hdr10', 'dolby-vision'] as const;
export const STUDIO_EXPORT_RESOLUTIONS = ['720p', '1080p', '1440p', '2160p'] as const;

/** A readable file name for a result: the project's name, without anything a path could use. */
export const studioExportFileName = (projectName: string, extension: string): string => {
  const cleaned = [...projectName]
    .map((character) => (character.codePointAt(0)! < 0x20 || character.codePointAt(0) === 0x7f ? ' ' : character))
    .join('')
    .replaceAll(/[/\\:*?"<>|]+/g, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return `${cleaned || 'Studio export'}${extension}`;
};

/** What the publication job's snapshot carries. The version row is the authority; this names it. */
export type StudioExportPublishSnapshot = {
  kind: 'studio-export-publish';
  versionId: string;
  renderOperationId: string;
  projectId: string;
  revision: number;
};

export const parseStudioExportPublishSnapshot = (value: unknown): StudioExportPublishSnapshot | null => {
  const snapshot = value as Partial<StudioExportPublishSnapshot> | null;
  if (
    !snapshot ||
    snapshot.kind !== 'studio-export-publish' ||
    typeof snapshot.versionId !== 'string' ||
    typeof snapshot.renderOperationId !== 'string' ||
    typeof snapshot.projectId !== 'string' ||
    typeof snapshot.revision !== 'number'
  ) {
    return null;
  }
  return snapshot as StudioExportPublishSnapshot;
};
