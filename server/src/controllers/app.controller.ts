import { Controller, Get, Header } from '@nestjs/common';
import { ApiExcludeEndpoint } from '@nestjs/swagger';
import { Authenticated } from 'src/middleware/auth.guard.js';
import { SystemConfigService } from 'src/services/system-config.service.js';

@Controller()
export class AppController {
  constructor(private service: SystemConfigService) {}

  @ApiExcludeEndpoint()
  @Get('.well-known/frameleaf')
  @Authenticated({ public: true })
  getFrameleafWellKnown() {
    return this.service.getWellKnown();
  }

  // Keep discovery working for installed clients during the rename.
  @ApiExcludeEndpoint()
  @Get('.well-known/immich')
  @Authenticated({ public: true })
  getImmichWellKnown() {
    return this.service.getWellKnown();
  }

  @ApiExcludeEndpoint()
  @Get('custom.css')
  @Authenticated({ public: true })
  @Header('Content-Type', 'text/css')
  getCustomCss() {
    return this.service.getCustomCss();
  }
}
