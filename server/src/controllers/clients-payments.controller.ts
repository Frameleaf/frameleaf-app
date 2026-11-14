import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import {
  ClientsPaymentAccountDto,
  ClientsPaymentConnectDto,
  ClientsPaymentConnectResponseDto,
} from 'src/dtos/clients-payments.dto.js';
import { ApiTag } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { ClientsPaymentsService } from 'src/services/clients-payments.service.js';

/** FL-1037: the signed-in studio's own payment account (Clients > Payments). */
@ApiTags(ApiTag.StudioProjects)
@Controller('photography/payment-account')
export class ClientsPaymentsController {
  constructor(private service: ClientsPaymentsService) {}

  @Get()
  @ApiOperation({ operationId: 'clientsPaymentAccount' })
  @Authenticated()
  @ApiResponse({ status: 200, type: ClientsPaymentAccountDto })
  account(@Auth() auth: AuthDto) {
    return this.service.account(auth);
  }

  @Post('connect')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ operationId: 'clientsPaymentAccountConnect' })
  @Authenticated()
  @ApiResponse({ status: 200, type: ClientsPaymentConnectResponseDto })
  connect(@Auth() auth: AuthDto, @Body() dto: ClientsPaymentConnectDto) {
    return this.service.connect(auth, dto);
  }

  @Delete()
  @ApiOperation({ operationId: 'clientsPaymentAccountDisconnect' })
  @Authenticated()
  @ApiResponse({ status: 200, type: ClientsPaymentAccountDto })
  disconnect(@Auth() auth: AuthDto) {
    return this.service.disconnect(auth);
  }
}
