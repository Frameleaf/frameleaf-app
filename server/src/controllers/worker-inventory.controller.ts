import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import { WorkerInventoryResponseDto } from 'src/dtos/worker-inventory.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Authenticated } from 'src/middleware/auth.guard.js';
import { WorkerInventoryService } from 'src/services/worker-inventory.service.js';

/**
 * The worker inventory (FL-72). Administrators only: it names every endpoint and how busy it is,
 * never whose media it holds. Changes go through the ML destination and render worker endpoints.
 */
@ApiTags(ApiTag.MlDestinations)
@Controller('admin/workers')
export class WorkerInventoryController {
  constructor(private service: WorkerInventoryService) {}

  @Get()
  @Authenticated({ permission: Permission.SystemConfigRead, admin: true })
  @Endpoint({
    summary: 'Get the worker inventory',
    description:
      'Every machine-learning, restoration and render endpoint with its last known state, acceleration, allowed and served workloads, library routes, per-workload admission and load, plus the server processes running restorations. Read-only; nothing is contacted.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  getWorkerInventory(): Promise<WorkerInventoryResponseDto> {
    return this.service.getInventory();
  }
}
