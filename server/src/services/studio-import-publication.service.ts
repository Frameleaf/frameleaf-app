import { Injectable, NotFoundException } from '@nestjs/common';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { StudioImportFileRepository } from 'src/repositories/studio-import-file.repository.js';
import { StudioImportPublicationRepository } from 'src/repositories/studio-import-publication.repository.js';
import type { StudioProjectImport } from 'src/repositories/studio-project.repository.js';
import { StudioProjectService } from 'src/services/studio-project.service.js';
import type {
  CancelResult,
  FilePort,
  JournalPort,
  PublicationKey,
  PublicationReceipt,
  PublicationState,
  ReceiptPage,
  RetentionUpload,
} from 'src/utils/studio-import-publication.js';
import { isStudioUuid } from 'src/utils/studio-resources.js';

export async function retainImport(
  journal: JournalPort,
  files: FilePort,
  upload: RetentionUpload,
): Promise<StudioProjectImport> {
  const prepared = await files.prepare(upload.key, upload.incoming, upload.declaration);
  const state = await journal.prepare(
    upload.key,
    prepared,
    (duplicate) => files.release(duplicate, 'stage'),
    upload.reservationId,
  );
  // No link or cleanup follows a rejected/unknown prepare acknowledgement.
  const retained =
    state.status === 'ready' ? state.imported : await journal.publish(upload.key, (file) => files.publish(file));
  // The ready row is committed; cleanup failures remain discoverable on the receipt.
  await journal.release(upload.key, (file, role) => files.release(file, role)).catch(() => undefined);
  return retained;
}

@Injectable()
export class StudioImportPublicationService {
  constructor(
    private readonly journal: StudioImportPublicationRepository,
    private readonly files: StudioImportFileRepository,
    private readonly studio: StudioProjectService,
  ) {}

  async register(
    auth: AuthDto,
    projectId: string,
    body: { importId: string; publicationId: string },
  ): Promise<PublicationReceipt> {
    const key = await this.authorize(auth, {
      ownerId: auth.user.id,
      projectId,
      importId: body.importId,
      publicationId: body.publicationId,
    });
    return this.journal.register(key);
  }

  async getPublication(auth: AuthDto, key: PublicationKey): Promise<PublicationReceipt | null> {
    return this.journal.get(await this.authorize(auth, key));
  }

  async discover(auth: AuthDto, projectId: string, cursor?: string, state?: PublicationState): Promise<ReceiptPage> {
    if (auth.sharedLink || !isStudioUuid(projectId)) throw new NotFoundException('Studio project not found');
    const project = await this.studio.requireOwnedProject(auth, projectId, 'Only the owner can inspect Studio imports');
    if (project.ownerId !== auth.user.id || project.id.toLowerCase() !== projectId.toLowerCase())
      throw new NotFoundException('Studio project not found');
    return this.journal.discover(auth.user.id, project.id, cursor, state);
  }

  async cancel(auth: AuthDto, key: PublicationKey): Promise<CancelResult> {
    return this.journal.cancel(await this.authorize(auth, key));
  }

  async retain(auth: AuthDto, upload: RetentionUpload): Promise<StudioProjectImport> {
    const key = await this.authorize(auth, upload.key);
    return retainImport(this.journal, this.files, { ...upload, key });
  }

  /** Internal recovery entry point: the repository rechecks the exact retained cleanup binding. */
  async release(key: PublicationKey): Promise<void> {
    await this.journal.release(key, (file, role) => this.files.release(file, role));
  }

  private async authorize(auth: AuthDto, key: PublicationKey): Promise<PublicationKey> {
    if (
      auth.sharedLink ||
      [key.ownerId, key.projectId, key.importId, key.publicationId].some((id) => !isStudioUuid(id)) ||
      key.ownerId.toLowerCase() !== auth.user.id.toLowerCase()
    ) {
      throw new NotFoundException('Studio project not found');
    }
    const project = await this.studio.requireOwnedProject(
      auth,
      key.projectId,
      'Only the owner can inspect Studio imports',
    );
    if (project.ownerId !== auth.user.id || project.id.toLowerCase() !== key.projectId.toLowerCase()) {
      throw new NotFoundException('Studio project not found');
    }
    return {
      ownerId: auth.user.id.toLowerCase(),
      projectId: project.id.toLowerCase(),
      importId: key.importId.toLowerCase(),
      publicationId: key.publicationId.toLowerCase(),
    };
  }
}
