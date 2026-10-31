import { Injectable } from '@nestjs/common';
import type { AuthDto, OAuthCheckDto, OAuthCheckResponseDto } from 'src/dtos/auth.dto.js';
import { BaseService } from 'src/services/base.service.js';

@Injectable()
export class AuthAdminService extends BaseService {
  async unlinkAll(_auth: AuthDto) {
    await this.userRepository.updateAll({ oauthId: null });
  }

  /**
   * FL-367: "Check" on Sign-in methods. Asks the provider for its discovery document with the
   * details typed so far (the saved secret when none is typed) and says what it found.
   */
  async checkOAuthProvider(dto: OAuthCheckDto): Promise<OAuthCheckResponseDto> {
    const { oauth } = await this.getConfig({ withCache: false });
    try {
      const { issuer } = await this.oauthRepository.check({
        ...oauth,
        issuerUrl: dto.issuerUrl,
        clientId: dto.clientId,
        clientSecret: dto.clientSecret || oauth.clientSecret,
        allowInsecureRequests: dto.allowInsecureRequests ?? oauth.allowInsecureRequests,
      });
      return { ok: true, issuer, error: null };
    } catch (error) {
      const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
      return { ok: false, issuer: null, error: cause instanceof Error ? cause.message : String(cause) };
    }
  }
}
