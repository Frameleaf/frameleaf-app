import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  PushActivityParamDto,
  PushActivityTokenDto,
  PushDeviceListResponseDto,
  PushDeviceRegisterDto,
  PushDeviceResponseDto,
  PushDeviceUpdateDto,
  PushStatusResponseDto,
} from 'src/dtos/push.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { PushService } from 'src/services/push.service.js';
import { UUIDParamDto } from 'src/validation.js';

/**
 * FL-228: the push device registry. A device registers from its own signed-in session; its tokens are
 * removed on logout, session revocation and account removal, and are never returned.
 */
@ApiTags(ApiTag.Push)
@Controller('push')
export class PushController {
  constructor(private service: PushService) {}

  @Get('status')
  @Authenticated({ permission: Permission.SessionRead })
  @Endpoint({
    summary: 'Push availability',
    description:
      'Whether this server delivers push notifications. Push needs a server linked to Frameleaf Cloud; an unlinked server answers available: false with the reason, so the app can say so. Also names the payload encryption and the events, and whether the calling session registered its device.',
    history: new HistoryBuilder().added('v3'),
  })
  getPushStatus(@Auth() auth: AuthDto): Promise<PushStatusResponseDto> {
    return this.service.getStatus(auth);
  }

  @Get('devices')
  @Authenticated({ permission: Permission.SessionRead })
  @Endpoint({
    summary: 'List own push devices',
    description: 'The devices registered for push on this account. Push tokens are never returned.',
    history: new HistoryBuilder().added('v3'),
  })
  listPushDevices(@Auth() auth: AuthDto): Promise<PushDeviceListResponseDto> {
    return this.service.listDevices(auth);
  }

  @Put('devices/current')
  @Authenticated({ permission: Permission.SessionUpdate })
  @Endpoint({
    summary: 'Register this device for push',
    description:
      "Registers or replaces the push registration of the calling session: platform, APNs or FCM token, the ActivityKit push-to-start token (iOS), the device's X25519 public key and notification preferences. Registering again rotates the tokens and key. Every payload is encrypted to the key (frameleaf-push-v1, specified in docs/developer/push-envelope-v1: envelope layout, key agreement, plaintext and test vectors); the Frameleaf push gateway receives only the target and the encrypted blob. Needs a signed-in device session (not an API key).",
    history: new HistoryBuilder().added('v3'),
  })
  registerPushDevice(@Auth() auth: AuthDto, @Body() dto: PushDeviceRegisterDto): Promise<PushDeviceResponseDto> {
    return this.service.register(auth, dto);
  }

  @Patch('devices/current')
  @Authenticated({ permission: Permission.SessionUpdate })
  @Endpoint({
    summary: 'Update this device’s push registration',
    description:
      'Changes a rotated token, the key, the linked backup device or preferences; omitted fields stay. Payloads follow frameleaf-push-v1 (docs/developer/push-envelope-v1).',
    history: new HistoryBuilder().added('v3'),
  })
  updatePushDevice(@Auth() auth: AuthDto, @Body() dto: PushDeviceUpdateDto): Promise<PushDeviceResponseDto> {
    return this.service.update(auth, dto);
  }

  @Delete('devices/current')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Authenticated({ permission: Permission.SessionDelete })
  @Endpoint({
    summary: 'Unregister this device from push',
    description: 'Removes the calling session’s push registration and its Live Activity tokens.',
    history: new HistoryBuilder().added('v3'),
  })
  unregisterPushDevice(@Auth() auth: AuthDto): Promise<void> {
    return this.service.unregisterCurrent(auth);
  }

  @Delete('devices/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Authenticated({ permission: Permission.SessionDelete })
  @Endpoint({
    summary: 'Remove an own push device',
    history: new HistoryBuilder().added('v3'),
  })
  removePushDevice(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<void> {
    return this.service.remove(auth, id);
  }

  @Put('devices/current/activities/:activityId')
  @Authenticated({ permission: Permission.SessionUpdate })
  @Endpoint({
    summary: 'Set a Live Activity push token',
    description:
      'iOS only: the ActivityKit update token of one Live Activity (the Cloud Backup activation), replaced when ActivityKit rotates it.',
    history: new HistoryBuilder().added('v3'),
  })
  setPushActivityToken(
    @Auth() auth: AuthDto,
    @Param() { activityId }: PushActivityParamDto,
    @Body() dto: PushActivityTokenDto,
  ): Promise<PushDeviceResponseDto> {
    return this.service.setActivityToken(auth, activityId, dto);
  }

  @Delete('devices/current/activities/:activityId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Authenticated({ permission: Permission.SessionUpdate })
  @Endpoint({
    summary: 'Remove a Live Activity push token',
    description: 'The activity ended on the device.',
    history: new HistoryBuilder().added('v3'),
  })
  removePushActivityToken(@Auth() auth: AuthDto, @Param() { activityId }: PushActivityParamDto): Promise<void> {
    return this.service.removeActivityToken(auth, activityId);
  }
}
