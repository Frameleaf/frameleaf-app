import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  ImportSignInAvailabilityResponseDto,
  ImportSignInCompleteDto,
  ImportSignInCompleteResponseDto,
  ImportSignInParamsDto,
  ImportSignInStartDto,
  ImportSignInStartResponseDto,
} from 'src/dtos/import-sign-in.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { ImportSignInService } from 'src/services/import-sign-in.service.js';

const history = () => new HistoryBuilder().added('v3.0.0').alpha('v3.0.0');

/** Sign in to a file provider for an import connection, through Frameleaf Cloud (FL-959). */
@ApiTags(ApiTag.Assets)
@Controller('import-connections/:provider/sign-in')
export class ImportSignInController {
  constructor(private service: ImportSignInService) {}

  @Get()
  @Authenticated({ permission: Permission.AssetUpload })
  @Endpoint({ summary: 'Check whether signing in to a provider is possible', history: history() })
  getImportSignIn(@Param() { provider }: ImportSignInParamsDto): Promise<ImportSignInAvailabilityResponseDto> {
    return this.service.availability(provider);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Authenticated({ permission: Permission.AssetUpload })
  @Endpoint({
    summary: 'Start signing in to a provider',
    description: 'A server that is not linked to a Frameleaf account is told to link it first.',
    history: history(),
  })
  startImportSignIn(
    @Auth() auth: AuthDto,
    @Param() { provider }: ImportSignInParamsDto,
    @Body() dto: ImportSignInStartDto,
  ): Promise<ImportSignInStartResponseDto> {
    return this.service.start(auth, provider, dto);
  }

  @Post('complete')
  @HttpCode(HttpStatus.OK)
  @Authenticated({ permission: Permission.AssetUpload })
  @Endpoint({
    summary: 'Finish signing in to a provider',
    description:
      'Ask until the state is no longer `pending`. Creates the connection, or renews the one named at the start.',
    history: history(),
  })
  completeImportSignIn(
    @Auth() auth: AuthDto,
    @Param() { provider }: ImportSignInParamsDto,
    @Body() dto: ImportSignInCompleteDto,
  ): Promise<ImportSignInCompleteResponseDto> {
    return this.service.complete(auth, provider, dto);
  }
}
