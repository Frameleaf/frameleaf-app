import { BadRequestException, Injectable } from '@nestjs/common';
import { DateTime } from 'luxon';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { ArgOf } from 'src/repositories/event.repository.js';
import { OnEvent, OnJob } from 'src/decorators.js';
import {
  SessionCreateDto,
  SessionCreateResponseDto,
  SessionResponseDto,
  SessionUpdateDto,
  mapSession,
} from 'src/dtos/session.dto.js';
import { JobName, JobStatus, Permission, QueueName } from 'src/enum.js';
import { BaseService } from 'src/services/base.service.js';

@Injectable()
export class SessionService extends BaseService {
  @OnJob({ name: JobName.SessionCleanup, queue: QueueName.BackgroundTask })
  async handleCleanup(): Promise<JobStatus> {
    const sessions = await this.sessionRepository.cleanup();
    for (const session of sessions) {
      this.logger.verbose(`Deleted expired session token: ${session.deviceOS}/${session.deviceType}`);
    }

    this.logger.log(`Deleted ${sessions.length} expired session tokens`);

    return JobStatus.Success;
  }

  async create(auth: AuthDto, dto: SessionCreateDto): Promise<SessionCreateResponseDto> {
    if (!auth.session) {
      throw new BadRequestException('This endpoint can only be used with a session token');
    }

    const token = this.cryptoRepository.randomBytesAsText(32);
    const hashed = this.cryptoRepository.hashSha256(token);
    const session = await this.sessionRepository.create({
      parentId: auth.session.id,
      userId: auth.user.id,
      expiresAt: dto.duration ? DateTime.now().plus({ seconds: dto.duration }).toJSDate() : null,
      deviceType: dto.deviceType,
      deviceOS: dto.deviceOS,
      token: hashed,
    });

    return { ...mapSession(session), token };
  }

  async getAll(auth: AuthDto): Promise<SessionResponseDto[]> {
    const sessions = await this.sessionRepository.getByUserId(auth.user.id);
    return sessions.map((session) => mapSession(session, auth.session?.id));
  }

  async update(auth: AuthDto, id: string, dto: SessionUpdateDto): Promise<SessionResponseDto> {
    await this.requireAccess({ auth, permission: Permission.SessionUpdate, ids: [id] });

    if (Object.values(dto).filter((prop) => prop !== undefined).length === 0) {
      throw new BadRequestException('No fields to update');
    }

    const session = await this.sessionRepository.update(id, {
      isPendingSyncReset: dto.isPendingSyncReset,
    });

    return mapSession(session);
  }

  async delete(auth: AuthDto, id: string): Promise<void> {
    await this.requireAccess({ auth, permission: Permission.AuthDeviceDelete, ids: [id] });
    await this.sessionRepository.delete(id);
    // FL-34: the revoked session's open tabs clear what they show and sign out
    await this.eventRepository.emit('SessionDelete', { sessionId: id });
  }

  async deleteAll(auth: AuthDto): Promise<void> {
    const userId = auth.user.id;
    const currentSessionId = auth.session?.id;
    const deletedIds = await this.sessionRepository.invalidateAll({ userId, excludeId: currentSessionId });
    for (const sessionId of deletedIds) {
      await this.eventRepository.emit('SessionDelete', { sessionId });
    }
  }

  async lock(auth: AuthDto, id: string): Promise<void> {
    await this.requireAccess({ auth, permission: Permission.SessionLock, ids: [id] });
    await this.sessionRepository.update(id, { pinExpiresAt: null });
    // FL-34: only the locked session's open tabs are told, once the lock is stored
    this.websocketRepository.clientSend('on_session_lock', id);
  }

  @OnEvent({ name: 'AuthChangePassword' })
  async onAuthChangePassword({ userId, currentSessionId }: ArgOf<'AuthChangePassword'>): Promise<void> {
    // FL-34: a password change revokes elevation everywhere, the retained session included
    await this.sessionRepository.lockAll(userId);
    this.websocketRepository.clientSend('on_session_lock', userId);
    const deletedIds = await this.sessionRepository.invalidateAll({ userId, excludeId: currentSessionId });
    for (const sessionId of deletedIds) {
      await this.eventRepository.emit('SessionDelete', { sessionId });
    }
  }
}
