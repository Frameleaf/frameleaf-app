import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { basename, join } from 'node:path';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { StudioProjectImportDto } from 'src/dtos/studio-project-import.dto.js';
import { CacheControl, StorageFolder } from 'src/enum.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { StudioProjectImport, StudioProjectRepository } from 'src/repositories/studio-project.repository.js';
import { StudioProjectService } from 'src/services/studio-project.service.js';
import { ImmichFileResponse } from 'src/utils/file.js';
import {
  STUDIO_IMPORT_MAX_BYTES,
  STUDIO_IMPORT_VECTOR_MAX_BYTES,
  type StudioImportKind,
  StudioImportRefusal,
  scanStudioVector,
  sniffStudioImport,
} from 'src/utils/studio-imports.js';
import { isStudioUuid } from 'src/utils/studio-resources.js';

const IMPORT_FOLDER = 'studio-imports';
const INCOMING_FOLDER = 'incoming';

/** Where an upload lands before it is checked: the uploader's own private exports folder. */
export const studioImportIncomingFolder = (ownerId: string) =>
  join(StorageCore.getFolderLocation(StorageFolder.Exports, ownerId), IMPORT_FOLDER, INCOMING_FOLDER);

/** Where a checked import is kept for the life of its project. */
export const studioImportProjectFolder = (ownerId: string, projectId: string) =>
  join(StorageCore.getFolderLocation(StorageFolder.Exports, ownerId), IMPORT_FOLDER, projectId);

const kindOf = (contentType: string): StudioImportKind =>
  contentType === 'image/svg+xml' || contentType === 'application/json'
    ? 'vector'
    : (contentType.split('/', 1)[0] as StudioImportKind);

export const mapStudioProjectImport = (item: StudioProjectImport): StudioProjectImportDto => ({
  id: item.id,
  kind: kindOf(item.contentType),
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
    private studio: StudioProjectService,
  ) {
    this.logger.setContext(StudioProjectImportService.name);
  }

  async upload(
    auth: AuthDto,
    projectId: string,
    id: string | undefined,
    file: Express.Multer.File | undefined,
  ): Promise<StudioProjectImportDto> {
    try {
      if (!file?.path) {
        throw new BadRequestException('Choose a file to import');
      }
      if (!isStudioUuid(id)) {
        throw new BadRequestException('The import needs the id the editor gave it');
      }
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
      if (type.kind === 'vector') {
        if (file.size > STUDIO_IMPORT_VECTOR_MAX_BYTES) {
          throw new PayloadTooLargeException('A vector graphic may be at most 16 MB');
        }
        const text = new TextDecoder('utf-8', { fatal: true }).decode(await this.storage.readFile(file.path));
        externalReferences = scanStudioVector(type, text) ?? null;
      }

      const checksum = (await this.crypto.hashFile(file.path, 'sha256')).toString('hex');
      const folder = studioImportProjectFolder(project.ownerId, project.id);
      const path = join(folder, `${id}${type.extension}`);
      const stored = await this.projects.registerImport({
        projectId: project.id,
        id: id!,
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
      if (error instanceof TypeError && /decode/i.test(error.message)) {
        throw new BadRequestException('A vector graphic must be UTF-8 text');
      }
      throw error;
    }
  }

  async list(auth: AuthDto, projectId: string): Promise<StudioProjectImportDto[]> {
    const project = await this.requireOwnedProject(auth, projectId);
    return (await this.projects.listImports(project.id)).map((item) => mapStudioProjectImport(item));
  }

  async getFile(auth: AuthDto, projectId: string, importId: string): Promise<ImmichFileResponse> {
    const project = await this.requireOwnedProject(auth, projectId);
    const item = await this.projects.getImport(project.id, importId);
    if (!item) {
      throw new NotFoundException('Studio project import not found');
    }
    return new ImmichFileResponse({
      path: item.path,
      contentType: item.contentType,
      // The bytes behind an id never change, so the browser may keep them for the session.
      cacheControl: CacheControl.PrivateWithCache,
      fileName: item.fileName,
    });
  }

  /** The owner's own project. A shared link, a reviewer or a stranger all get `404`. */
  private async requireOwnedProject(auth: AuthDto, projectId: string) {
    if (auth.sharedLink) {
      throw new NotFoundException('Studio project not found');
    }
    const project = await this.projects.getById(projectId);
    if (!project || project.ownerId !== auth.user.id) {
      throw new NotFoundException('Studio project not found');
    }
    return project;
  }
}
