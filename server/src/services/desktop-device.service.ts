import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { createPublicKey, verify } from 'node:crypto';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import {
  DesktopCapabilitiesDto,
  DesktopDeviceDto,
  DesktopEnrollmentDto,
  DesktopEnrollmentSchema,
  enrollmentMessage,
} from 'src/dtos/desktop.dto.js';
import { DesktopDeviceRepository, DesktopDeviceRow } from 'src/repositories/desktop-device.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { stableServerId } from 'src/utils/frameleaf-server-identity.js';

@Injectable()
export class DesktopDeviceService {
  constructor(
    private repository: DesktopDeviceRepository,
    private systemMetadataRepository: SystemMetadataRepository,
  ) {}

  async capabilities(auth: AuthDto): Promise<DesktopCapabilitiesDto> {
    this.requirePhotoSession(auth);
    return {
      protocolVersion: 1,
      serverId: await stableServerId({ systemMetadataRepository: this.systemMetadataRepository }),
      enrollmentPolicy: 'administrators',
      features: { enrollment: true, worker: false, sources: false, nativeHost: false },
    };
  }

  async enroll(auth: AuthDto, input: DesktopEnrollmentDto): Promise<DesktopDeviceDto> {
    this.requirePhotoSession(auth);
    const dto = DesktopEnrollmentSchema.parse(input);
    if (Math.abs(Date.now() - dto.timestamp) > 120_000) throw new ForbiddenException('device_proof_expired');
    const serverId = await stableServerId({ systemMetadataRepository: this.systemMetadataRepository });
    const key = createPublicKey({
      key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(dto.publicKey, 'base64')]),
      format: 'der',
      type: 'spki',
    });
    if (
      !verify(
        null,
        Buffer.from(enrollmentMessage(serverId, auth.user.id, dto)),
        key,
        Buffer.from(dto.signature, 'base64'),
      )
    ) {
      throw new ForbiddenException('device_proof_invalid');
    }
    const row = await this.repository.enroll({
      userId: auth.user.id,
      installationId: dto.installationId,
      publicKey: dto.publicKey,
      name: dto.name,
      platform: dto.platform,
      architecture: dto.architecture,
      mode: dto.mode,
      state: auth.user.isAdmin ? 'preparing' : 'awaiting-approval',
    });
    if (!row) throw new ConflictException('desktop_identity_revoked_or_changed');
    return this.map(row);
  }

  async list(auth: AuthDto): Promise<DesktopDeviceDto[]> {
    this.requirePhotoSession(auth);
    return (await this.repository.list(auth.user.id)).map((row) => this.map(row));
  }

  async endSession(auth: AuthDto, id: string): Promise<void> {
    this.requirePhotoSession(auth);
    if (!(await this.repository.endSession(auth.user.id, id))) throw new NotFoundException('Desktop device not found');
  }

  async revoke(auth: AuthDto, id: string): Promise<void> {
    this.requirePhotoSession(auth);
    if (!(await this.repository.revoke(auth.user.id, id))) throw new NotFoundException('Desktop device not found');
  }

  private requirePhotoSession(auth: AuthDto): void {
    if (!auth.session || auth.apiKey || auth.sharedLink || auth.system)
      throw new ForbiddenException('desktop_photo_session_required');
  }

  private map(row: DesktopDeviceRow): DesktopDeviceDto {
    return {
      id: row.id,
      installationId: row.installationId,
      name: row.name,
      platform: row.platform,
      architecture: row.architecture,
      mode: row.mode,
      state: row.state,
      createdAt: new Date(row.createdAt).toISOString(),
      revokedAt: row.revokedAt ? new Date(row.revokedAt).toISOString() : null,
      routeEffects: { changed: [], preserved: 'all' },
    };
  }
}
