import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { ApiKey } from 'src/database.js';
import {
  ApiKeyCreateDto,
  ApiKeyCreateResponseDto,
  ApiKeyResponseDto,
  ApiKeyUpdateDto,
  splitApiKeyPermissions,
} from 'src/dtos/api-key.dto.js';
import { Permission, SystemMetadataKey } from 'src/enum.js';
import { BaseService } from 'src/services/base.service.js';
import { isGranted } from 'src/utils/access.js';
import { findOrFail } from 'src/utils/misc.js';

@Injectable()
export class ApiKeyService extends BaseService {
  async create(auth: AuthDto, dto: ApiKeyCreateDto): Promise<ApiKeyCreateResponseDto> {
    const token = this.cryptoRepository.randomBytesAsText(32);
    const hashed = this.cryptoRepository.hashSha256(token);

    if (auth.apiKey && !isGranted({ requested: dto.permissions, current: auth.apiKey.permissions })) {
      throw new BadRequestException('Cannot grant permissions you do not have');
    }

    const entity = await this.apiKeyRepository.create({
      key: hashed,
      name: dto.name || 'API Key',
      userId: auth.user.id,
      permissions: dto.permissions,
    });
    const apiKey = this.map(entity, {}, {});

    return { ...apiKey, secret: token, apiKey };
  }

  async update(auth: AuthDto, id: string, dto: ApiKeyUpdateDto): Promise<ApiKeyResponseDto> {
    const exists = await this.apiKeyRepository.getById(auth.user.id, id);
    if (!exists) {
      throw new BadRequestException('API Key not found');
    }

    if (
      auth.apiKey &&
      dto.permissions &&
      !isGranted({ requested: dto.permissions, current: auth.apiKey.permissions })
    ) {
      throw new BadRequestException('Cannot grant permissions you do not have');
    }

    await this.refuseSignedIn(auth, id);

    const key = await this.apiKeyRepository.update(auth.user.id, id, { name: dto.name, permissions: dto.permissions });

    return this.map(key, await this.lastUsed(), {});
  }

  async rotate(auth: AuthDto, id: string): Promise<ApiKeyCreateResponseDto> {
    const existing = await findOrFail(() => this.apiKeyRepository.getById(auth.user.id, id), 'API Key');

    if (
      auth.apiKey &&
      !isGranted({ requested: existing.permissions as Permission[], current: auth.apiKey.permissions })
    ) {
      throw new BadRequestException('Cannot rotate an API Key with permissions you do not have');
    }

    await this.refuseSignedIn(auth, id);

    const token = this.cryptoRepository.randomBytesAsText(32);
    const hashed = this.cryptoRepository.hashSha256(token);
    const newKey = await this.apiKeyRepository.update(auth.user.id, id, { key: hashed });
    const apiKey = this.map(newKey, await this.lastUsed(), {});

    return { ...apiKey, secret: token, apiKey };
  }

  async delete(auth: AuthDto, id: string): Promise<void> {
    const exists = await this.apiKeyRepository.getById(auth.user.id, id);
    if (!exists) {
      throw new BadRequestException('API Key not found');
    }

    await this.apiKeyRepository.delete(auth.user.id, id);
  }

  async getMine(auth: AuthDto): Promise<ApiKeyResponseDto> {
    if (!auth.apiKey) {
      throw new ForbiddenException('Not authenticated with an API Key');
    }

    const key = await this.apiKeyRepository.getById(auth.user.id, auth.apiKey.id);
    if (!key) {
      throw new BadRequestException('API Key not found');
    }

    return this.map(key, await this.lastUsed(), await this.signedIn(auth));
  }

  async getById(auth: AuthDto, id: string): Promise<ApiKeyResponseDto> {
    const key = await this.apiKeyRepository.getById(auth.user.id, id);
    if (!key) {
      throw new BadRequestException('API Key not found');
    }
    return this.map(key, await this.lastUsed(), await this.signedIn(auth));
  }

  async getAll(auth: AuthDto): Promise<ApiKeyResponseDto[]> {
    const keys = await this.apiKeyRepository.getByUserId(auth.user.id);
    const [used, signedIn] = await Promise.all([this.lastUsed(), this.signedIn(auth)]);
    return keys.map((key) => this.map(key, used, signedIn));
  }

  /** FL-655: the keys Save to Frameleaf added by signing in, by key id. */
  private signedIn(auth: AuthDto): Promise<Record<string, string>> {
    return this.apiKeyRepository.getSignedInClients(auth.user.id);
  }

  /**
   * FL-655: an access added by signing in has no value to show or replace and no permissions to
   * change; it can only be removed (and Save to Frameleaf signs in again to get a new one).
   */
  private async refuseSignedIn(auth: AuthDto, id: string) {
    if ((await this.signedIn(auth))[id]) {
      throw new BadRequestException(
        'Save to Frameleaf’s access can only be removed. Sign in again from the extension.',
      );
    }
  }

  /** FL-367: when each key was last used, as `AuthService` records it. */
  private async lastUsed(): Promise<Record<string, string>> {
    return (await this.systemMetadataRepository.get(SystemMetadataKey.ApiKeyLastUsed)) ?? {};
  }

  private map(entity: ApiKey, used: Record<string, string>, signedIn: Record<string, string>): ApiKeyResponseDto {
    return {
      id: entity.id,
      name: entity.name,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
      ...splitApiKeyPermissions(entity.permissions as Permission[]),
      lastUsedAt: used[entity.id] ?? null,
      signedInFrom: signedIn[entity.id] ?? null,
    };
  }
}
