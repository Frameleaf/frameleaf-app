import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { ArgOf } from 'src/repositories/event.repository.js';
import { OnEvent } from 'src/decorators.js';
import { StudioWorkspaceDto, StudioWorkspaceSaveDto } from 'src/dtos/studio-project.dto.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { StudioProjectRepository } from 'src/repositories/studio-project.repository.js';

const asIso = (value: Date | string) => (value instanceof Date ? value : new Date(value)).toISOString();

/**
 * Each account's Studio workspace layout (FL-91, `STU-204`), the server equivalent of Freecut's
 * workspace folder. It belongs to the signed-in account alone: there is no way to read or write
 * another account's layout, and nothing here touches a project or its media.
 */
@Injectable()
export class StudioWorkspaceService {
  constructor(
    private logger: LoggingRepository,
    private repository: StudioProjectRepository,
  ) {
    this.logger.setContext(StudioWorkspaceService.name);
  }

  async get(auth: AuthDto): Promise<StudioWorkspaceDto> {
    const stored = await this.repository.getWorkspace(auth.user.id);
    return stored
      ? { layout: stored.layout, engineRevision: stored.engineRevision, savedAt: asIso(stored.savedAt) }
      : { layout: null, engineRevision: null, savedAt: null };
  }

  async save(auth: AuthDto, dto: StudioWorkspaceSaveDto): Promise<StudioWorkspaceDto> {
    const saved = await this.repository.saveWorkspace(auth.user.id, dto.layout, dto.engineRevision);
    if (!saved) {
      // The fork schema is mid-handoff: nothing was stored, and the answer says so.
      throw new ServiceUnavailableException('Workspace layouts cannot be saved right now');
    }
    return { layout: dto.layout, engineRevision: dto.engineRevision, savedAt: asIso(saved.savedAt) };
  }

  @OnEvent({ name: 'UserDelete' })
  async onUserDelete({ id }: ArgOf<'UserDelete'>): Promise<void> {
    await this.repository.deleteWorkspace(id);
  }
}
