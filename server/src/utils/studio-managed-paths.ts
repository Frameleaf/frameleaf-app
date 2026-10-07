import { join, relative } from 'node:path';
import { StorageCore } from 'src/cores/storage.core.js';
import { StorageFolder } from 'src/enum.js';
import { isInsideFolder, studioExportRoot, studioExportStagingFolder } from 'src/utils/studio-export.js';
import { isStudioUuid } from 'src/utils/studio-resources.js';

/** Only ordinary import files and immutable Buddy copies have a managed deletion namespace. */
export const isManagedStudioImportPath = (item: { ownerId: string; projectId: string; id: string; path: string }) => {
  if (![item.ownerId, item.projectId, item.id].every(isStudioUuid)) return false;
  const root = StorageCore.getFolderLocation(StorageFolder.Exports, item.ownerId);
  const ordinary = relative(join(root, 'studio-imports', item.projectId), item.path);
  const restored = relative(join(root, 'buddy-projects', item.projectId), item.path).split('/');
  return (
    new RegExp(String.raw`^${item.id}\.[a-zA-Z0-9]+$`).test(ordinary) ||
    (restored.length === 2 && isStudioUuid(restored[0]) && /^[a-f0-9]{64}(?:\.[a-zA-Z0-9.]*)?$/.test(restored[1]))
  );
};

export const isManagedStudioExportPath = (item: {
  ownerId: string;
  id: string;
  renderOperationId: string | null;
  projectId: string | null;
  outputPath: string;
}) => {
  if (![item.ownerId, item.id].every(isStudioUuid)) return false;
  const version = relative(join(studioExportRoot(item.ownerId), 'versions'), item.outputPath);
  if (new RegExp(String.raw`^${item.id}\.[a-zA-Z0-9]+$`).test(version)) return true;
  const stillAttempt = new RegExp(String.raw`^${item.id}-([a-f0-9-]+)\.(?:jpg|heic)$`).exec(version);
  if (stillAttempt && isStudioUuid(stillAttempt[1])) return true;
  if (
    item.renderOperationId &&
    isStudioUuid(item.renderOperationId) &&
    isInsideFolder(studioExportStagingFolder(item.ownerId, item.renderOperationId), item.outputPath)
  )
    return true;
  const restored = relative(
    join(StorageCore.getFolderLocation(StorageFolder.Exports, item.ownerId), 'buddy-projects'),
    item.outputPath,
  ).split('/');
  return (
    restored.length === 3 &&
    isStudioUuid(restored[0]) &&
    (!item.projectId || restored[0] === item.projectId) &&
    isStudioUuid(restored[1]) &&
    /^[a-f0-9]{64}(?:\.[a-zA-Z0-9.]*)?$/.test(restored[2])
  );
};
