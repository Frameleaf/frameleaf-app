import { R_OK } from 'node:constants';
import path from 'node:path';
import picomatch from 'picomatch';
import { StorageCore } from 'src/cores/storage.core.js';
import { LibraryImportPathReason } from 'src/enum.js';

/**
 * External library folder rules (FL-78).
 *
 * One place decides whether a folder may be an import folder, used by the check the library form
 * offers, by create and update, and by every scan before it touches a single item. A folder is
 * refused for its form (relative, `..`, control characters), for where it is (the upload folder,
 * or a folder containing it), for clashing with another folder (listed twice, nested inside another
 * of the same library, overlapping another library's) and — when the disk is consulted — for not
 * being a readable directory right now.
 */
export type ImportPathCheck = {
  importPath: string;
  isValid: boolean;
  reason: LibraryImportPathReason;
  message?: string;
};

export type ImportPathStorage = {
  stat(filepath: string): Promise<{ isDirectory(): boolean }>;
  checkFileExists(filepath: string, mode?: number): Promise<boolean>;
};

/** Another library's folders, for the overlap check. */
export type ImportPathNeighbour = { id: string; name: string; importPaths: string[] };

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u{0}-\u{1F}\u{7F}]/u;

const valid = (importPath: string): ImportPathCheck => ({
  importPath,
  isValid: true,
  reason: LibraryImportPathReason.Valid,
});

const invalid = (importPath: string, reason: LibraryImportPathReason, message: string): ImportPathCheck => ({
  importPath,
  isValid: false,
  reason,
  message,
});

/** `/mnt/photos/` and `/mnt//photos` are the folder `/mnt/photos`; the root stays `/`. */
export const normalizeImportPath = (value: string): string => {
  const normalized = path.posix.normalize(value);
  return normalized.length > 1 && normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
};

/** Whether `child` is `parent` or somewhere below it, compared on normalized folders. */
export const isSameOrInside = (child: string, parent: string): boolean => {
  const a = normalizeImportPath(child);
  const b = normalizeImportPath(parent);
  return a === b || a.startsWith(b === '/' ? '/' : `${b}/`);
};

const overlaps = (a: string, b: string) => isSameOrInside(a, b) || isSameOrInside(b, a);

/** The form and location of one folder, without touching the disk. Null when it passes. */
export const checkImportPathFormat = (importPath: string): ImportPathCheck | null => {
  if (CONTROL_CHARACTERS.test(importPath)) {
    return invalid(importPath, LibraryImportPathReason.InvalidCharacters, 'Import path contains control characters');
  }

  if (StorageCore.isImmichPath(importPath)) {
    return invalid(
      importPath,
      LibraryImportPathReason.UploadFolder,
      'Cannot use media upload folder for external libraries',
    );
  }

  if (!path.isAbsolute(importPath)) {
    return invalid(
      importPath,
      LibraryImportPathReason.NotAbsolute,
      `Import path must be absolute, try ${path.resolve(importPath)}`,
    );
  }

  if (importPath.split('/').includes('..')) {
    return invalid(
      importPath,
      LibraryImportPathReason.ParentTraversal,
      'Import path must not use parent-directory segments',
    );
  }

  // `/` or `/mnt` above the upload folder would crawl every upload into an external library
  if (isSameOrInside(StorageCore.getMediaLocation(), importPath)) {
    return invalid(
      importPath,
      LibraryImportPathReason.ContainsUploadFolder,
      'Import path contains the media upload folder',
    );
  }

  return null;
};

/** Whether the folder is, right now, a directory this server can read. */
export const checkImportPathOnDisk = async (
  storage: ImportPathStorage,
  importPath: string,
): Promise<ImportPathCheck> => {
  try {
    const stat = await storage.stat(importPath);
    if (!stat.isDirectory()) {
      return invalid(importPath, LibraryImportPathReason.NotDirectory, 'Not a directory');
    }
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      return invalid(importPath, LibraryImportPathReason.NotFound, 'Path does not exist (ENOENT)');
    }
    return invalid(importPath, LibraryImportPathReason.Unavailable, String(error));
  }

  if (!(await storage.checkFileExists(importPath, R_OK))) {
    return invalid(importPath, LibraryImportPathReason.NotReadable, 'Lacking read permission for folder');
  }

  return valid(importPath);
};

/**
 * Every folder of a list, in order: form and location first, then clashes within the list and with
 * other libraries, then — unless `checkDisk` is false — whether it can be read. The first problem
 * found for a folder is the one reported.
 */
export const checkImportPaths = async (
  storage: ImportPathStorage,
  importPaths: string[],
  options: { neighbours?: ImportPathNeighbour[]; checkDisk?: boolean } = {},
): Promise<ImportPathCheck[]> => {
  const neighbours = options.neighbours ?? [];
  const normalized = importPaths.map((importPath) => normalizeImportPath(importPath));

  return Promise.all(
    importPaths.map(async (importPath, index) => {
      const format = checkImportPathFormat(importPath);
      if (format) {
        return format;
      }

      const self = normalized[index];
      if (normalized.some((other, otherIndex) => otherIndex < index && other === self)) {
        return invalid(importPath, LibraryImportPathReason.Duplicate, 'Import path is listed more than once');
      }

      if (normalized.some((other, otherIndex) => otherIndex !== index && other !== self && overlaps(self, other))) {
        return invalid(
          importPath,
          LibraryImportPathReason.Nested,
          'Import path is inside another import path of this library',
        );
      }

      const clash = neighbours.find((neighbour) => neighbour.importPaths.some((other) => overlaps(self, other)));
      if (clash) {
        return invalid(
          importPath,
          LibraryImportPathReason.OtherLibrary,
          `Import path overlaps an import path of library ${clash.name}`,
        );
      }

      return options.checkDisk === false ? valid(importPath) : checkImportPathOnDisk(storage, importPath);
    }),
  );
};

/** Exclusion patterns that are not usable globs; empty means every pattern is fine. */
export const invalidExclusionPatterns = (patterns: string[]): string[] =>
  patterns.filter((pattern) => {
    if (CONTROL_CHARACTERS.test(pattern)) {
      return true;
    }
    try {
      picomatch.makeRe(pattern);
      return false;
    } catch {
      return true;
    }
  });
