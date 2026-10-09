import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { HiddenContentFilter } from 'src/utils/hidden-content.js';
import { CastMediaUrlCreateDto, CastMediaUrlResponseDto } from 'src/dtos/cast.dto.js';
import { Permission } from 'src/enum.js';
import { BaseService } from 'src/services/base.service.js';
import { isGranted } from 'src/utils/access.js';
import {
  CAST_MEDIA_PURPOSE,
  CAST_MEDIA_TTL_MS,
  CastMediaKind,
  castMediaPath,
  signCastMediaToken,
  verifyCastMediaToken,
} from 'src/utils/cast-media.js';
import { identityDirectory } from 'src/utils/frameleaf-cloud-gateway.js';
import { hasHiddenContentFilter } from 'src/utils/hidden-content.js';
import { getPreferences } from 'src/utils/preferences.js';

export type CastMediaRead = { auth: AuthDto; assetId: string; kind: CastMediaKind };

const INVALID_CAST_URL = 'This Cast link is invalid or has expired';

/**
 * Item-scoped, short-lived media URLs for Cast receivers (see `src/utils/cast-media.ts`). Issuing needs
 * a signed-in session or API key with access to the item; reading needs only the signed URL, and
 * re-checks everything the issue checked.
 */
@Injectable()
export class CastService extends BaseService {
  async createMediaUrl(auth: AuthDto, id: string, dto: CastMediaUrlCreateDto): Promise<CastMediaUrlResponseDto> {
    if (auth.sharedLink || (!auth.session && !auth.apiKey)) {
      throw new ForbiddenException('Casting needs a signed-in account');
    }
    this.requireKeyPermission(auth, dto.kind);
    await this.requireAccess({ auth, permission: this.permissionOf(dto.kind), ids: [id] });
    await this.requireCastable(auth.user.id, id);

    const expiresAt = Date.now() + CAST_MEDIA_TTL_MS;
    const token = await signCastMediaToken(
      {
        v: 1,
        a: id,
        u: auth.user.id,
        s: auth.session?.id ?? null,
        k: auth.session ? null : (auth.apiKey?.id ?? null),
        m: dto.kind,
        e: expiresAt,
      },
      this.mac,
    );
    return { assetId: id, kind: dto.kind, path: castMediaPath(token), expiresAt: new Date(expiresAt).toISOString() };
  }

  /**
   * The account and item a signed Cast URL serves, after checking the signature and expiry, that the
   * session (or API key) it was issued from still exists, that the account still has access, and that
   * the item is still castable for it. The caller serves the rendition with the returned auth.
   */
  async resolveMediaUrl(token: string): Promise<CastMediaRead> {
    const claims = await verifyCastMediaToken(token, this.mac);
    if (!claims) {
      throw new UnauthorizedException(INVALID_CAST_URL);
    }
    const user = await this.userRepository.get(claims.u, {});
    if (!user) {
      throw new UnauthorizedException(INVALID_CAST_URL);
    }
    const auth: AuthDto = {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        isAdmin: user.isAdmin,
        quotaSizeInBytes: user.quotaSizeInBytes,
        quotaUsageInBytes: user.quotaUsageInBytes,
      },
    };
    if (claims.s) {
      const session = await this.sessionRepository.get(claims.s);
      if (!session || (session.expiresAt && new Date(session.expiresAt).getTime() <= Date.now())) {
        throw new UnauthorizedException(INVALID_CAST_URL);
      }
      // never elevated: a Locked item is not cast even from a PIN-unlocked session
      auth.session = { id: session.id, hasElevatedPermission: false };
    } else if (claims.k) {
      const apiKey = await this.apiKeyRepository.getById(claims.u, claims.k);
      if (!apiKey) {
        throw new UnauthorizedException(INVALID_CAST_URL);
      }
      auth.apiKey = { id: apiKey.id, permissions: apiKey.permissions };
    } else {
      throw new UnauthorizedException(INVALID_CAST_URL);
    }

    this.requireKeyPermission(auth, claims.m);
    await this.requireAccess({ auth, permission: this.permissionOf(claims.m), ids: [claims.a] });
    const hiddenContent = await this.requireCastable(user.id, claims.a);
    if (hiddenContent) {
      auth.hiddenContent = hiddenContent;
      auth.suppressedContent = hiddenContent;
      auth.hideNsfwAssets = true;
    }
    return { auth, assetId: claims.a, kind: claims.m };
  }

  private requireKeyPermission(auth: AuthDto, kind: CastMediaKind): void {
    if (auth.apiKey && !isGranted({ requested: [this.permissionOf(kind)], current: auth.apiKey.permissions })) {
      throw new ForbiddenException('API key cannot access this Cast rendition');
    }
  }

  private permissionOf(kind: CastMediaKind) {
    return kind === CastMediaKind.Original ? Permission.AssetDownload : Permission.AssetView;
  }

  /**
   * Refuses an account whose casting an administrator turned off, and an item that is Locked or holds
   * one of the account's hidden people, pets or tags. Returns the account's hidden-content filter.
   */
  private async requireCastable(userId: string, assetId: string): Promise<HiddenContentFilter | undefined> {
    const preferences = getPreferences(await this.userRepository.getMetadata(userId));
    if (preferences.cast.adminDisabled) {
      throw new ForbiddenException('An administrator has turned casting off for this account');
    }
    const filter = { userId, includeNsfw: false, ...preferences.privacy.suppression };
    const hiddenContent = hasHiddenContentFilter(filter) ? filter : undefined;
    if (!(await this.assetRepository.isCastable(assetId, hiddenContent))) {
      throw new ForbiddenException('This item cannot be cast');
    }
    return hiddenContent;
  }

  private mac = (payload: string) =>
    this.cryptoRepository.serverKeyedHash(identityDirectory(this.configRepository), CAST_MEDIA_PURPOSE, payload);
}
