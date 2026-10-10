import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { basename, join } from 'node:path';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { StudioProjectInventoryDto } from 'src/dtos/studio-inventory.dto.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { StudioProjectImportDto } from 'src/dtos/studio-project-import.dto.js';
import { CacheControl, StorageFolder } from 'src/enum.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { StudioProjectImport, StudioProjectRepository } from 'src/repositories/studio-project.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { StudioProjectService } from 'src/services/studio-project.service.js';
import {
  assertOwnerRestoreFile,
  assertOwnerRestorePath,
  captureOwnerRestoreFile,
} from 'src/utils/cloud-backup-owner-path.js';
import { ImmichFileResponse } from 'src/utils/file.js';
import {
  STUDIO_IMPORT_MAX_BYTES,
  STUDIO_IMPORT_TEXT_LIMITS,
  StudioImportRefusal,
  scanStudioVector,
  sniffStudioImport,
  studioImportKind,
  validateStudioImportText,
} from 'src/utils/studio-imports.js';
import { studioProjectResourceUses } from 'src/utils/studio-inventory.js';
import { isManagedStudioImportPath } from 'src/utils/studio-managed-paths.js';
import { isStudioUuid } from 'src/utils/studio-resources.js';
import { parseStudioLottieDependencies } from 'src/utils/studio-vector-dependencies.js';

const IMPORT_FOLDER = 'studio-imports';
/** An upload older than this in the incoming folder belongs to a request that never finished. */
const STUDIO_IMPORT_INCOMING_TTL_MS = 6 * 60 * 60 * 1000;
const INCOMING_FOLDER = 'incoming';

/** Where an upload lands before it is checked: the uploader's own private exports folder. */
export const studioImportIncomingFolder = (ownerId: string) =>
  join(StorageCore.getFolderLocation(StorageFolder.Exports, ownerId), IMPORT_FOLDER, INCOMING_FOLDER);

/** Where a checked import is kept for the life of its project. */
export const studioImportProjectFolder = (ownerId: string, projectId: string) =>
  join(StorageCore.getFolderLocation(StorageFolder.Exports, ownerId), IMPORT_FOLDER, projectId);

export const mapStudioProjectImport = (item: StudioProjectImport): StudioProjectImportDto => ({
  id: item.id,
  kind: studioImportKind(item.contentType),
  contentType: item.contentType,
  fileName: item.fileName,
  sizeBytes: item.sizeBytes,
  checksum: item.checksum,
  externalReferences: item.externalReferences,
  createdAt: new Date(item.createdAt).toISOString(),
});

/**
 * Files uploaded into a Studio project (FL-103 microphone recordings, FL-105 media import).
 *
 * Only the project's owner uploads, lists and reads them, the same person who holds the write
 * lease; a reviewer in a shared space never receives the graph, so never its files either. Every
 * other caller gets `404`, as for a project that does not exist. The bytes are the owner's personal
 * data and stay in the owner's private storage; renders and previews reach them only through the
 * FL-90 resolver, which declares them from here and issues its own revision-bound grants.
 */
@Injectable()
export class StudioProjectImportService {
  constructor(
    private logger: LoggingRepository,
    private projects: StudioProjectRepository,
    private storage: StorageRepository,
    private crypto: CryptoRepository,
    private users: UserRepository,
    private studio: StudioProjectService,
  ) {
    this.logger.setContext(StudioProjectImportService.name);
  }

  async upload(
    auth: AuthDto,
    projectId: string,
    rawId: string | undefined,
    file: Express.Multer.File | undefined,
  ): Promise<StudioProjectImportDto> {
    let textLabel = 'The file';
    try {
      if (!file?.path) {
        throw new BadRequestException('Choose a file to import');
      }
      if (!isStudioUuid(rawId)) {
        throw new BadRequestException('The import needs the id the editor gave it');
      }
      // Postgres answers ids in lower case; the stored path and every retry use the same spelling.
      const id = rawId.toLowerCase();
      const project = await this.requireOwnedProject(auth, projectId);
      if (project.deletedAt || project.archivedAt) {
        throw new ConflictException('Restore this project before adding files to it');
      }
      if (file.size === 0) {
        throw new BadRequestException('The file is empty');
      }
      if (file.size > STUDIO_IMPORT_MAX_BYTES) {
        throw new PayloadTooLargeException('The file is larger than a Studio import may be');
      }

      const head = await this.storage.readFile(file.path, {
        buffer: Buffer.alloc(1024),
        position: 0,
        length: 1024,
      });
      const type = sniffStudioImport(new Uint8Array(head.subarray(0, Math.min(file.size, 1024))), file.mimetype);
      let externalReferences: number | null = null;
      // Graphics, caption files and LUTs are text: bounded, read whole and checked in full.
      const limit = STUDIO_IMPORT_TEXT_LIMITS[type.kind];
      if (limit) {
        textLabel = limit.label;
        if (file.size > limit.maxBytes) {
          throw new PayloadTooLargeException(`${limit.label} may be at most ${limit.maxBytes / 1024 / 1024} MB`);
        }
        const text = new TextDecoder('utf-8', { fatal: true }).decode(await this.storage.readFile(file.path));
        externalReferences = scanStudioVector(type, text) ?? null;
        validateStudioImportText(type, text);
        if (type.kind === 'vector' && type.contentType !== 'image/svg+xml') parseStudioLottieDependencies(text);
      }

      // A retry of an import already kept is answered by it; anything new counts against the quota.
      if (!(await this.projects.getImport(project.id, id))) {
        await this.assertQuota(project.ownerId, file.size);
      }

      const checksum = (await this.crypto.hashFile(file.path, 'sha256')).toString('hex');
      const folder = studioImportProjectFolder(project.ownerId, project.id);
      const path = join(folder, `${id}${type.extension}`);
      const stored = await this.projects.registerImport({
        projectId: project.id,
        id,
        ownerId: project.ownerId,
        contentType: type.contentType,
        checksum,
        sizeBytes: file.size,
        path,
        fileName: basename(file.originalname || `import${type.extension}`).slice(0, 255) || `import${type.extension}`,
        externalReferences,
      });

      if (stored.path === path && !(await this.storage.checkFileExists(path))) {
        this.storage.mkdirSync(folder);
        await this.storage.rename(file.path, path);
      } else {
        // A retry of a file already kept: the stored copy is the same bytes.
        await this.storage.unlink(file.path);
      }
      this.studio.forgetResolutions([project.id]);
      this.logger.log(`Studio project ${project.id} import ${stored.id} registered (${stored.contentType})`);
      return mapStudioProjectImport(stored);
    } catch (error) {
      if (file?.path) {
        await this.storage.unlink(file.path).catch(() => {});
      }
      if (error instanceof StudioImportRefusal) {
        throw new BadRequestException(error.message);
      }
      if ((error as { code?: unknown }).code === 'ERR_ENCODING_INVALID_ENCODED_DATA') {
        throw new BadRequestException(`${textLabel} must be UTF-8 text`);
      }
      throw error;
    }
  }

  async list(auth: AuthDto, projectId: string): Promise<StudioProjectImportDto[]> {
    const project = await this.requireOwnedProject(auth, projectId);
    return (await this.projects.listImports(project.id)).map((item) => mapStudioProjectImport(item));
  }

  /**
   * FL-348: what a project keeps and uses. The files kept with it, and the fonts, bundled LUTs and
   * models its head graph names, each with whether it may run on this server. Owner only, like the
   * kept files themselves.
   */
  async inventory(auth: AuthDto, projectId: string): Promise<StudioProjectInventoryDto> {
    const project = await this.requireOwnedProject(auth, projectId);
    const keptFiles = (await this.projects.listImports(project.id)).map((item) => mapStudioProjectImport(item));
    const head =
      project.currentRevision > 0 ? await this.projects.getRevision(project.id, project.currentRevision) : undefined;
    const graph = (head?.envelope as { graph?: unknown } | undefined)?.graph ?? null;
    const uses = studioProjectResourceUses(graph);
    return {
      projectId: project.id,
      revision: head ? project.currentRevision : 0,
      keptFiles,
      fonts: uses.filter((use) => use.kind === 'font'),
      luts: uses.filter((use) => use.kind === 'lut'),
      models: uses.filter((use) => use.kind === 'model'),
    };
  }

  async getFile(auth: AuthDto, projectId: string, importId: string): Promise<ImmichFileResponse> {
    const project = await this.requireOwnedProject(auth, projectId);
    const item = await this.projects.getImport(project.id, importId);
    if (!item) {
      throw new NotFoundException('Studio project import not found');
    }
    return new ImmichFileResponse({
      path: item.path,
      // An SVG is declared UTF-8, the only encoding its scan accepted.
      contentType: item.contentType === 'image/svg+xml' ? 'image/svg+xml; charset=utf-8' : item.contentType,
      // The bytes behind an id never change, so the browser may keep them for the session.
      cacheControl: CacheControl.PrivateWithCache,
      fileName: item.fileName,
    });
  }

  /**
   * Remove what outlives its project: the files of imports whose project was deleted for good, and
   * uploads left in the incoming folder by a request that failed before it was answered. Run by the
   * Studio lifecycle sweep.
   */
  async sweep(now: Date = new Date()): Promise<void> {
    // Each registered path is guarded separately. Never remove an entire folder: it can hold
    // capture-pinned bytes or unknown files, and restored imports live outside studio-imports.
    for (const orphan of await this.projects.listOrphanImportProjects()) {
      try {
        await this.projects.deleteImports(orphan.projectId, orphan.ownerId, async (item) => {
          if (!isManagedStudioImportPath(item))
            throw new Error('Studio import cleanup path is not a declared managed file');
          await assertOwnerRestorePath([StorageCore.getBaseFolder(StorageFolder.Exports)], item.path);
          const evidence = await captureOwnerRestoreFile(item.path, async (path) =>
            (await this.crypto.hashFile(path, 'sha256')).toString('hex'),
          );
          if (evidence.identity && (evidence.sha256 !== item.checksum || evidence.size !== BigInt(item.sizeBytes)))
            throw new Error('Studio import cleanup file identity changed');
          await assertOwnerRestoreFile(item.path, evidence.identity);
          await this.storage.unlink(item.path);
        });
      } catch (error) {
        this.logger.warn(`Could not remove the imports of deleted Studio project ${orphan.projectId}: ${error}`);
        continue;
      }
    }
    const exports = StorageCore.getBaseFolder(StorageFolder.Exports);
    for (const ownerId of await this.storage.readdir(exports).catch(() => [] as string[])) {
      if (!isStudioUuid(ownerId)) {
        continue;
      }
      const incoming = studioImportIncomingFolder(ownerId);
      for (const name of await this.storage.readdir(incoming).catch(() => [] as string[])) {
        const path = join(incoming, name);
        const stat = await this.storage.stat(path).catch(() => null);
        if (stat && now.getTime() - stat.mtime.getTime() > STUDIO_IMPORT_INCOMING_TTL_MS) {
          await this.storage.unlink(path).catch(() => {});
        }
      }
    }
  }

  /** New imports count against the owner's storage quota with their library, when one is set. */
  private async assertQuota(ownerId: string, bytes: number) {
    const user = await this.users.get(ownerId, {});
    if (!user || user.quotaSizeInBytes === null || user.quotaSizeInBytes === undefined) {
      return;
    }
    const used = Number(user.quotaUsageInBytes) + (await this.projects.getImportBytes(ownerId));
    if (used + bytes > Number(user.quotaSizeInBytes)) {
      throw new PayloadTooLargeException('This file would take you over your storage quota');
    }
  }

  /**
   * The owner's own project. A shared link or someone who cannot see the project gets `404`, as for
   * a project that does not exist; a reviewer, who can see it, gets `403` (FL-112 ruling, 2026-09-30).
   */
  private async requireOwnedProject(auth: AuthDto, projectId: string) {
    if (auth.sharedLink || !isStudioUuid(projectId)) {
      throw new NotFoundException('Studio project not found');
    }
    return this.studio.requireOwnedProject(auth, projectId, 'Only the owner can import into a Studio project');
  }
}
