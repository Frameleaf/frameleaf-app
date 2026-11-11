import { ForbiddenException, Inject, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { SignJWT, jwtVerify } from 'jose';
import z from 'zod';
import type { AuthOAuthApp } from 'src/dtos/auth.dto.js';
import type { FrameleafVia } from 'src/utils/frameleaf-sign-in.js';
import { AssetMediaSize } from 'src/dtos/asset-media.dto.js';
import { CacheControl } from 'src/enum.js';
import { AssetMediaService } from 'src/services/asset-media.service.js';
import { AuthService } from 'src/services/auth.service.js';
import { BaseService } from 'src/services/base.service.js';
import { OAuthAppService } from 'src/services/oauth-app.service.js';
import { FileDownloadResponse } from 'src/utils/file.js';
import { identityDirectory } from 'src/utils/frameleaf-cloud-gateway.js';

const purpose = 'mcp-preview-v1';
const claims = z.object({ sub: z.uuid(), jti: z.uuid() });

@Injectable()
export class McpPreviewService extends BaseService {
  @Inject(OAuthAppService) private readonly oauth!: OAuthAppService;
  @Inject(AuthService) private readonly auth!: AuthService;
  @Inject(AssetMediaService) private readonly media!: AssetMediaService;

  async createUrl(app: AuthOAuthApp, resource: string, assetId: string) {
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256', typ: purpose })
      .setAudience(resource)
      .setSubject(app.grantId)
      .setJti(assetId)
      .setExpirationTime('5m')
      .sign(await this.signingKey());
    return `${resource}/preview?token=${token}`;
  }

  async read(token: unknown, resource: string, via: FrameleafVia | null) {
    if (typeof token !== 'string' || token.length > 1024) {
      throw new UnauthorizedException();
    }
    const key = await this.signingKey();
    const verified = await jwtVerify(token, key, {
      algorithms: ['HS256'],
      typ: purpose,
      audience: resource,
      requiredClaims: ['exp'],
    }).catch(() => null);
    const parsed = claims.safeParse(verified?.payload);
    if (!parsed.success) {
      throw new UnauthorizedException();
    }
    const { sub: grantId, jti: assetId } = parsed.data;
    const grant = await this.oauth.validatePreviewGrant(grantId);
    const auth = await this.auth.authorizeMcpGrant(grant, resource, via);
    if (!auth.oauthApp.scopes.includes('library:read')) {
      throw new ForbiddenException();
    }
    if (!(await this.assetRepository.isCastable(assetId, auth.hiddenContent, true))) {
      throw new NotFoundException();
    }
    const preview = await this.media.viewThumbnail(auth, assetId, { size: AssetMediaSize.THUMBNAIL }, via);
    if (!(preview instanceof FileDownloadResponse)) {
      throw new NotFoundException();
    }
    return new FileDownloadResponse({ ...preview, fileName: undefined, cacheControl: CacheControl.None });
  }

  private async signingKey() {
    const key = await this.cryptoRepository.serverKeyedHash(identityDirectory(this.configRepository), purpose, '');
    return Buffer.from(key, 'base64url');
  }
}
