import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import path from 'node:path';
import type { Selectable } from 'kysely';
import { AuthDto } from 'src/dtos/auth.dto.js';
import {
  EagleImportCreateDto,
  EagleImportListResponseDto,
  EagleImportQueryDto,
  EagleImportResponseDto,
  EagleLibrariesResponseDto,
  EagleLibraryCheckDto,
  EagleLibraryResponseDto,
} from 'src/dtos/eagle-import.dto.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { EagleImportRepository } from 'src/repositories/eagle-import.repository.js';
import { EagleLibraryRepository } from 'src/repositories/eagle-library.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { TakeoutStagingError, TakeoutStagingRepository } from 'src/repositories/takeout-staging.repository.js';
import { EagleImportTable } from 'src/schema/tables/eagle-import.table.js';
import { requireUploadsNotPaused } from 'src/utils/access.js';
import { asDateTimeString } from 'src/utils/date.js';
import { BOARDS_EXTENSIONS, EagleServerLibrary, buildEagleLibrary, eagleFolders } from 'src/utils/eagle-library.js';
import { mimeTypes } from 'src/utils/mime-types.js';

type EagleImportRow = Selectable<EagleImportTable>;

/** File types the server import brings over: the ones Boards holds that this server takes. */
export const eagleServerSupported = () =>
  new Set(BOARDS_EXTENSIONS.filter((extension) => mimeTypes.isAsset(`file.${extension}`)));

export const isLibraryFolder = (folder: string) => path.basename(folder).toLowerCase().endsWith('.library');

/**
 * FL-653: "In a folder your server can open". An administrator allows import folders with
 * `FRAMELEAF_IMPORT_ROOTS` (the same list Google Photos imports use). Here an administrator, in a
 * signed-in session, picks a `.library` folder inside one of them; the check reads its lists, and
 * starting hands it to the server's import worker, which keeps going with the tab closed. The Eagle
 * library is only ever read.
 */
@Injectable()
export class EagleImportService {
  constructor(
    private logger: LoggingRepository,
    private config: ConfigRepository,
    private repository: EagleImportRepository,
    private libraries: EagleLibraryRepository,
    private staging: TakeoutStagingRepository,
  ) {
    this.logger.setContext(EagleImportService.name);
  }

  /** The `.library` folders in every allowed import folder. */
  async listLibraries(auth: AuthDto): Promise<EagleLibrariesResponseDto> {
    this.requireAdminSession(auth);
    const roots = this.roots();
    const libraries = [];
    for (const [index, root] of roots.entries()) {
      const found = await this.libraries.findLibraries(root).catch((error: unknown) => {
        this.logger.warn(`Import folder ${index} could not be read: ${String(error)}`);
        return [] as string[];
      });
      libraries.push(
        ...found.map((relative) => ({ rootId: String(index), path: relative, name: path.basename(relative) })),
      );
    }
    return { roots: roots.length, libraries };
  }

  /** The chosen library's lists, for the check before importing. Nothing is imported yet. */
  async check(auth: AuthDto, dto: EagleLibraryCheckDto): Promise<EagleLibraryResponseDto> {
    this.requireAdminSession(auth);
    const directory = await this.resolve(dto.rootId, dto.path);
    const library = await this.read(directory);
    return {
      name: library.name,
      folders: eagleFolders(library.folders).map(({ id, name, parent, description, color, icon }) => ({
        id,
        name,
        parentId: parent,
        ...(description && { description }),
        ...(color && { color }),
        ...(icon && { icon }),
      })),
      smartFolders: library.smartFolders,
      tagGroups: library.tagGroups,
      ...(library.changed && { changed: library.changed }),
      items: library.items.map(({ fileName: _fileName, unreadable, ...item }) => ({
        ...item,
        unreadable: unreadable ?? false,
      })),
      fingerprint: library.fingerprint,
      supported: [...eagleServerSupported()],
    };
  }

  /** Starts the import, or carries on an earlier one of the same library from where it got to. */
  async create(auth: AuthDto, dto: EagleImportCreateDto): Promise<EagleImportResponseDto> {
    this.requireAdminSession(auth);
    requireUploadsNotPaused(auth);
    const directory = await this.resolve(dto.rootId, dto.path);
    const library = await this.read(directory);
    if (library.fingerprint !== dto.fingerprint) {
      throw new ConflictException('This library changed since it was checked. Check it again.');
    }
    const target = dto.targetMode === 'top' ? { mode: 'top' } : { mode: 'inside', inside: dto.insideAlbumId ?? 'new' };
    const earlier = await this.repository.findResumable(auth.user.id, directory, library.fingerprint);
    if (earlier) {
      if (earlier.status === 'running' || earlier.status === 'stopping') {
        return this.present(earlier);
      }
      const restarted = await this.repository.restart(earlier.id, { target, existingTop: dto.existingTop });
      if (restarted) {
        this.logger.log(`Eagle import ${earlier.id} carries on`);
        return this.present(restarted);
      }
    }
    const row = await this.repository.create({
      ownerId: auth.user.id,
      rootId: dto.rootId,
      relativePath: dto.path,
      libraryPath: directory,
      libraryName: library.name,
      fingerprint: library.fingerprint,
      target,
      existingTop: dto.existingTop,
    });
    this.logger.log(`Eagle import ${row.id} started from a server folder`);
    return this.present(row);
  }

  async get(auth: AuthDto, id: string, query: EagleImportQueryDto): Promise<EagleImportResponseDto> {
    this.requireSession(auth);
    const row = await this.repository.getOwned(id, auth.user.id);
    if (!row) {
      throw new NotFoundException('Import not found');
    }
    return this.present(row, query.outcomes);
  }

  /** Your imports from a server folder that haven't finished, newest first. */
  async listUnfinished(auth: AuthDto): Promise<EagleImportListResponseDto> {
    this.requireSession(auth);
    const rows = await this.repository.listUnfinished(auth.user.id);
    return { imports: await Promise.all(rows.map((row) => this.present(row))) };
  }

  /** Stops after the item being brought over now; everything already brought over stays. */
  async stop(auth: AuthDto, id: string): Promise<EagleImportResponseDto> {
    this.requireSession(auth);
    const stopped = await this.repository.requestStop(id, auth.user.id);
    if (stopped) {
      return this.present(stopped);
    }
    return this.get(auth, id, {});
  }

  /** Reads a library folder the server already resolved. */
  async read(directory: string): Promise<EagleServerLibrary> {
    const metadata = await this.libraries.readLibraryMetadata(directory);
    if (metadata === undefined) {
      throw new BadRequestException('This folder isn’t an Eagle library, or its list can’t be read');
    }
    const library = buildEagleLibrary(
      path.basename(directory),
      metadata,
      await this.libraries.readInfoFolders(directory),
    );
    if (!library) {
      throw new BadRequestException('This folder isn’t an Eagle library, or its list can’t be read');
    }
    return library;
  }

  private roots() {
    return this.config.getEnv().storage.importRoots;
  }

  /**
   * The library folder inside an allowed import folder: it must exist, be reached without a link,
   * stay inside that folder, keep out of the library's own storage, and end in `.library`.
   */
  private async resolve(rootId: string, relative: string) {
    const roots = this.roots();
    const root = /^\d+$/.test(rootId) ? roots[Number(rootId)] : undefined;
    if (!root) {
      throw new BadRequestException('Choose one of the permitted import locations');
    }
    let directory: string;
    try {
      directory = await this.staging.resolveDirectory(root, relative);
    } catch (error) {
      throw error instanceof TakeoutStagingError ? new BadRequestException(error.message) : error;
    }
    if (!isLibraryFolder(directory)) {
      throw new BadRequestException('Choose the folder whose name ends in .library');
    }
    return directory;
  }

  /**
   * A server folder is an administrator's choice made in a signed-in session; an API key, even an
   * administrator's, never points the server at its own drives (as for Google Photos imports).
   */
  private requireAdminSession(auth: AuthDto) {
    this.requireSession(auth);
    if (!auth.user.isAdmin) {
      throw new ForbiddenException('Only an administrator can import from a server folder');
    }
  }

  private requireSession(auth: AuthDto) {
    if (auth.apiKey || auth.sharedLink || !auth.session) {
      throw new ForbiddenException('Imports from a server folder need a signed-in session');
    }
  }

  async present(row: EagleImportRow, withOutcomes = false): Promise<EagleImportResponseDto> {
    const { done, already } = await this.repository.counts(row.id);
    const target = row.target as { mode?: string; inside?: string };
    const outcomes = withOutcomes
      ? Object.fromEntries(
          (await this.repository.outcomes(row.id)).map(({ itemId, assetId, duplicate }) => [
            itemId,
            { assetId, duplicate },
          ]),
        )
      : undefined;
    return {
      id: row.id,
      rootId: row.rootId,
      path: row.relativePath,
      libraryName: row.libraryName,
      fingerprint: row.fingerprint,
      status: row.status,
      targetMode: target.mode === 'top' ? 'top' : 'inside',
      insideAlbumId: target.mode === 'inside' && target.inside && target.inside !== 'new' ? target.inside : null,
      rootAlbumId: row.rootAlbumId,
      total: row.total,
      done,
      already,
      collections: Object.keys(row.albums).length,
      failed: row.failed,
      recent: row.recent,
      error: row.error,
      ...(outcomes && { outcomes }),
      createdAt: asDateTimeString(row.createdAt),
      updatedAt: asDateTimeString(row.updatedAt),
    };
  }
}
