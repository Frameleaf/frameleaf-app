import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  MailConnectionStateDto,
  MailDisconnectResponseDto,
  MailSignInCompleteResponseDto,
  MailSignInStartDto,
  MailSignInStartResponseDto,
} from 'src/dtos/mail-connection.dto.js';
import { ApiTag } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { MailConnectionService } from 'src/services/mail-connection.service.js';

/** FL-379: the Gmail or Microsoft account this server sends email from, connected by signing in. */
@ApiTags(ApiTag.NotificationsAdmin)
@Controller('admin/notifications/mail-connection')
export class MailConnectionController {
  constructor(private service: MailConnectionService) {}

  @Get()
  @Authenticated({ admin: true })
  @Endpoint({
    summary: 'Get the mail account connection',
    description:
      'The Gmail or Microsoft account this server sends email from, whether it needs a new sign-in, and which providers can be connected by signing in.',
    history: new HistoryBuilder().added('v3.2.1').alpha('v3.2.1'),
  })
  getMailConnection(): Promise<MailConnectionStateDto> {
    return this.service.getState();
  }

  @Post('start')
  @Authenticated({ admin: true })
  @HttpCode(HttpStatus.OK)
  @Endpoint({
    summary: 'Start a mail account sign-in',
    description:
      "Start connecting a Gmail or Microsoft account. The answer is the provider's sign-in page to open in the browser; the server must be linked to a Frameleaf Cloud account.",
    history: new HistoryBuilder().added('v3.2.1').alpha('v3.2.1'),
  })
  startMailSignIn(@Auth() auth: AuthDto, @Body() dto: MailSignInStartDto): Promise<MailSignInStartResponseDto> {
    return this.service.start(auth, dto);
  }

  @Post('complete')
  @Authenticated({ admin: true })
  @HttpCode(HttpStatus.OK)
  @Endpoint({
    summary: 'Complete a mail account sign-in',
    description:
      'Ask whether the sign-in in progress has finished at the provider, and connect the account when it has. Call it every few seconds while `state` is `pending`.',
    history: new HistoryBuilder().added('v3.2.1').alpha('v3.2.1'),
  })
  completeMailSignIn(@Auth() auth: AuthDto): Promise<MailSignInCompleteResponseDto> {
    return this.service.complete(auth);
  }

  @Delete()
  @Authenticated({ admin: true })
  @Endpoint({
    summary: 'Disconnect the mail account',
    description:
      'Stop sending from the connected account: access is revoked at the provider where the provider allows it, the stored token is deleted and email is switched off until another way of sending is set up.',
    history: new HistoryBuilder().added('v3.2.1').alpha('v3.2.1'),
  })
  disconnectMailAccount(@Auth() auth: AuthDto): Promise<MailDisconnectResponseDto> {
    return this.service.disconnect(auth);
  }
}
