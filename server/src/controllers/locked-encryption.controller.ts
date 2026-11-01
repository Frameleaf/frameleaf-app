import { Body, Controller, Delete, Get, Header, HttpCode, HttpStatus, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  LockedEncryptionDisableDto,
  LockedEncryptionEnableDto,
  LockedEncryptionPartnerUnlockDto,
  LockedEncryptionRecoverDto,
  LockedEncryptionRecoveryKeyDto,
  LockedEncryptionRecoveryKeyResponseDto,
  LockedEncryptionStatusResponseDto,
  LockedEncryptionUnlockDto,
  LockedEncryptionUpdateDto,
} from 'src/dtos/locked-encryption.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { LockedEncryptionService } from 'src/services/locked-encryption.service.js';

const history = () => new HistoryBuilder().added('v3.2.0').alpha('v3.2.0');

/**
 * FL-721 (spec §10): the signed-in person's own Locked encryption; no route takes a user id. The
 * recovery key is in the two responses that create it, never stored or cached (`no-store`).
 */
@ApiTags(ApiTag.LockedEncryption)
@Controller('users/me/locked-encryption')
export class LockedEncryptionController {
  constructor(private service: LockedEncryptionService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  @Authenticated({ permission: Permission.UserPreferenceRead, refreshElevation: false })
  @Endpoint({
    summary: 'Get your Locked encryption status',
    description:
      'FL-721: whether it is on and how, whether your key is open on this server now and until when, progress while encrypting or decrypting, and how many Locked items are encrypted or in a folder Frameleaf can’t change.',
    history: history(),
  })
  getLockedEncryption(@Auth() auth: AuthDto): Promise<LockedEncryptionStatusResponseDto> {
    return this.service.getStatus(auth);
  }

  @Post()
  @Header('Cache-Control', 'no-store')
  @Authenticated({ permission: Permission.UserPreferenceUpdate })
  @Endpoint({
    summary: 'Turn on Locked encryption',
    description:
      'FL-721: with your Locked PIN, and a passphrase for Advanced Security. Creates your key and returns your recovery key, once; it is never shown again. Your Locked items are then encrypted in the background.',
    history: history(),
  })
  enableLockedEncryption(
    @Auth() auth: AuthDto,
    @Body() dto: LockedEncryptionEnableDto,
  ): Promise<LockedEncryptionRecoveryKeyResponseDto> {
    return this.service.enable(auth, dto);
  }

  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  @Authenticated({ permission: Permission.UserPreferenceUpdate })
  @Endpoint({
    summary: 'Turn off Locked encryption',
    description:
      'FL-721: with your PIN (PIN mode) or passphrase (Advanced Security). Your Locked items are decrypted back to ordinary files in the background; then your key and recovery key are deleted.',
    history: history(),
  })
  disableLockedEncryption(@Auth() auth: AuthDto, @Body() dto: LockedEncryptionDisableDto): Promise<void> {
    return this.service.disable(auth, dto);
  }

  @Put()
  @HttpCode(HttpStatus.NO_CONTENT)
  @Authenticated({ permission: Permission.UserPreferenceUpdate })
  @Endpoint({
    summary: 'Change your Locked encryption',
    description:
      'FL-721: switch between PIN and Advanced Security, change your passphrase, or when the passphrase is asked for again. Switching or a new passphrase needs your current PIN or passphrase.',
    history: history(),
  })
  updateLockedEncryption(@Auth() auth: AuthDto, @Body() dto: LockedEncryptionUpdateDto): Promise<void> {
    return this.service.update(auth, dto);
  }

  @Post('unlock')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Authenticated({ permission: Permission.UserPreferenceUpdate })
  @Endpoint({
    summary: 'Open your Locked encryption key',
    description:
      'FL-721, Advanced Security: your passphrase opens your key on this server until it is asked for again or the server restarts. Tries are limited as for the Locked PIN.',
    history: history(),
  })
  unlockLockedEncryption(@Auth() auth: AuthDto, @Body() dto: LockedEncryptionUnlockDto): Promise<void> {
    return this.service.unlock(auth, dto);
  }

  @Post('partner-unlock')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Authenticated({ permission: Permission.UserPreferenceUpdate })
  @Endpoint({
    summary: 'Open a partner’s encrypted Locked items',
    description:
      'FL-721: for a partner who shares their library with you and uses Advanced Security. Their passphrase, typed after your own PIN (or your own passphrase), opens their shared Locked items for you only, until their key is asked for again or they lock it. Tries are limited as for the Locked PIN.',
    history: history(),
  })
  unlockPartnerLockedEncryption(@Auth() auth: AuthDto, @Body() dto: LockedEncryptionPartnerUnlockDto): Promise<void> {
    return this.service.unlockPartner(auth, dto);
  }

  @Post('lock')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Authenticated({ permission: Permission.UserPreferenceUpdate })
  @Endpoint({
    summary: 'Lock now',
    description:
      'FL-721: closes your key on this server, so Locked asks for your passphrase (or PIN) again. Not available while encryption is being turned off.',
    history: history(),
  })
  lockLockedEncryption(@Auth() auth: AuthDto): Promise<void> {
    return this.service.lock(auth);
  }

  @Post('recovery-key')
  @Header('Cache-Control', 'no-store')
  @Authenticated({ permission: Permission.UserPreferenceUpdate })
  @Endpoint({
    summary: 'Make a new Locked encryption recovery key',
    description:
      'FL-721: with your PIN or passphrase. The old recovery key stops working; the new one is returned once and never shown again.',
    history: history(),
  })
  createLockedEncryptionRecoveryKey(
    @Auth() auth: AuthDto,
    @Body() dto: LockedEncryptionRecoveryKeyDto,
  ): Promise<LockedEncryptionRecoveryKeyResponseDto> {
    return this.service.newRecoveryKey(auth, dto);
  }

  @Post('recover')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Authenticated({ permission: Permission.UserPreferenceUpdate })
  @Endpoint({
    summary: 'Reset a forgotten Locked PIN or passphrase',
    description:
      'FL-721: your recovery key opens your key, and the new PIN or passphrase replaces the old one. Tries are limited as for the Locked PIN.',
    history: history(),
  })
  recoverLockedEncryption(@Auth() auth: AuthDto, @Body() dto: LockedEncryptionRecoverDto): Promise<void> {
    return this.service.recover(auth, dto);
  }
}
