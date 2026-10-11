import { Injectable, NotFoundException } from '@nestjs/common';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { StudioProjectImport } from 'src/repositories/studio-project.repository.js';
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
import { StudioImportFileRepository } from 'src/repositories/studio-import-file.repository.js';
import { StudioImportPublicationRepository } from 'src/repositories/studio-import-publication.repository.js';
import { StudioProjectService } from 'src/services/studio-project.service.js';
import { type ImportFaults, noImportFaults } from 'src/utils/studio-import-faults.js';
import { isStudioUuid } from 'src/utils/studio-resources.js';
import { UUIDv7ParamDto } from 'src/validation.js';

export async function retainImport(
  journal: JournalPort,
  files: FilePort,
  upload: RetentionUpload,
  faults: ImportFaults = noImportFaults,
): Promise<StudioProjectImport> {
  const prepared = await files.prepare(upload.key, upload.incoming, upload.declaration);
  const state = await journal.prepare(
    upload.key,
    prepared,
    (duplicate) => files.release(duplicate, 'stage'),
    upload.reservationId,
  );
  await faults.reached('prepare-commit');
  // No link or cleanup follows a rejected/unknown prepare acknowledgement.
  const retained =
    state.status === 'ready' ? state.imported : await journal.publish(upload.key, (file) => files.publish(file));
  if (state.status !== 'ready') await faults.reached('publication-commit');
  // The ready row is committed; cleanup failures remain discoverable on the receipt.
  await journal.release(upload.key, (file, role) => files.release(file, role)).catch(() => {});
  return retained;
}

@Injectable()
export class StudioImportPublicationService {
  private recoveryAfter?: string;
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

  async findPublication(auth: AuthDto, projectId: string, publicationId: string): Promise<PublicationReceipt | null> {
    if (auth.sharedLink || !UUIDv7ParamDto.schema.safeParse({ id: projectId }).success || !isStudioUuid(publicationId))
      throw new NotFoundException('Studio project not found');
    const project = await this.studio.requireOwnedProject(auth, projectId, 'Only the owner can inspect Studio imports');
    if (project.ownerId !== auth.user.id || project.id.toLowerCase() !== projectId.toLowerCase())
      throw new NotFoundException('Studio project not found');
    return this.journal.getByPublication(
      auth.user.id.toLowerCase(),
      project.id.toLowerCase(),
      publicationId.toLowerCase(),
    );
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

  async recover(): Promise<{ attempted: number; deferred: number }> {
    let candidates = await this.journal.listRecovery(200, this.recoveryAfter);
    if (candidates.length === 0 && this.recoveryAfter) {
      this.recoveryAfter = undefined;
      candidates = await this.journal.listRecovery(200);
    }
    this.recoveryAfter = candidates.at(-1)?.publicationId;
    let deferred = 0;
    for (const key of candidates) {
      try {
        await this.release(key);
      } catch {
        deferred++;
      }
    }
    return { attempted: candidates.length, deferred };
  }

  async cleanupIncoming(
    ownerId: string,
    path: string,
    cutoff: Date,
    removeExact: (identity: string | null) => Promise<void>,
  ): Promise<boolean> {
    return this.journal.cleanupIncoming(ownerId, path, cutoff, removeExact);
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
