import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  AssetLedgerAdminSummaryResponseDto,
  AssetLedgerListResponseDto,
  AssetLedgerQueryDto,
  AssetLedgerSummaryResponseDto,
} from 'src/dtos/asset-ledger.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { AssetLedgerService } from 'src/services/asset-ledger.service.js';

const history = () => new HistoryBuilder().added('v3.4.0').alpha('v3.4.0');

/** FL-921: the nothing-lost ledger, for the account that is signed in. */
@ApiTags(ApiTag.Users)
@Controller('users/me/ledger')
export class AssetLedgerController {
  constructor(private service: AssetLedgerService) {}

  @Get('summary')
  @Authenticated({ permission: Permission.AssetRead })
  @Endpoint({
    summary: 'Get your nothing-lost totals',
    description:
      'How many of the originals the server accepted for you are kept, in the Trash, removed, sharing an identical file, or missing with no record of a removal.',
    history: history(),
  })
  getLedgerSummary(@Auth() auth: AuthDto): Promise<AssetLedgerSummaryResponseDto> {
    return this.service.getSummary(auth);
  }

  @Get()
  @Authenticated({ permission: Permission.AssetRead })
  @Endpoint({
    summary: 'List your originals and where they are now',
    description:
      'Every original the server accepted for you, the newest change first: where it is now, since when, who put it there and why. Photos that are locked are listed only while they are unlocked.',
    history: history(),
  })
  getLedger(@Auth() auth: AuthDto, @Query() dto: AssetLedgerQueryDto): Promise<AssetLedgerListResponseDto> {
    return this.service.getItems(auth, dto);
  }
}

/** FL-921: the whole server's totals, for administrators. */
@ApiTags(ApiTag.UsersAdmin)
@Controller('admin/ledger')
export class AssetLedgerAdminController {
  constructor(private service: AssetLedgerService) {}

  @Get('summary')
  @Authenticated({ permission: Permission.ServerStatistics, admin: true })
  @Endpoint({
    summary: 'Get the server’s nothing-lost totals',
    description:
      'How many of the originals the server accepted, for every account, are kept, in the Trash, removed, sharing an identical file, or missing, and which accounts have originals the server cannot account for. No file is named.',
    history: history(),
  })
  getLedgerAdminSummary(): Promise<AssetLedgerAdminSummaryResponseDto> {
    return this.service.getAdminSummary();
  }
}
