import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  LegacyWorkflowTriggerResponseDto,
  WorkflowBatchParamsDto,
  WorkflowBatchResponseDto,
  WorkflowCapabilitiesDto,
  WorkflowCreateDto,
  WorkflowDiscoveryResponseDto,
  WorkflowGetLogsDto,
  WorkflowLogEntryDto,
  WorkflowPreviewDto,
  WorkflowPreviewResponseDto,
  WorkflowResponseDto,
  WorkflowRunParamsDto,
  WorkflowSearchDto,
  WorkflowShareResponseDto,
  WorkflowUpdateDto,
} from 'src/dtos/workflow.dto.js';
import { Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { WorkflowService } from 'src/services/workflow.service.js';
import { UUIDParamDto } from 'src/validation.js';

@ApiTags('Workflows')
@Controller('workflows')
export class WorkflowController {
  constructor(private service: WorkflowService) {}

  @Post()
  @Authenticated({ permission: Permission.WorkflowCreate })
  @Endpoint({
    summary: 'Create a workflow',
    description: 'Create a new workflow, the workflow can also be created with empty filters and actions.',
    history: HistoryBuilder.v3(),
  })
  createWorkflow(@Auth() auth: AuthDto, @Body() dto: WorkflowCreateDto): Promise<WorkflowResponseDto> {
    return this.service.create(auth, dto);
  }

  @Get()
  @Authenticated({ permission: Permission.WorkflowRead })
  @Endpoint({
    summary: 'List all workflows',
    description: 'Retrieve a list of workflows available to the authenticated user.',
    history: HistoryBuilder.v3(),
  })
  searchWorkflows(@Auth() auth: AuthDto, @Query() dto: WorkflowSearchDto): Promise<WorkflowResponseDto[]> {
    return this.service.search(auth, dto);
  }

  @Get('triggers')
  @Authenticated({ permission: false })
  @Endpoint({
    summary: 'List all workflow triggers',
    description: 'Retrieve a list of all available workflow triggers.',
    history: HistoryBuilder.v3(),
  })
  getWorkflowTriggers(): LegacyWorkflowTriggerResponseDto[] {
    return this.service.getTriggers();
  }

  @Get('automation/discovery')
  @Authenticated({ permission: Permission.PluginRead })
  @Endpoint({
    summary: 'Discover all workflow triggers and plugin templates',
    description:
      'Includes change-driven and scheduled automation. Legacy discovery endpoints retain their original trigger values.',
    history: HistoryBuilder.v3(),
  })
  getWorkflowDiscovery(): Promise<WorkflowDiscoveryResponseDto> {
    return this.service.discovery();
  }

  @Get('automation/capabilities')
  @Authenticated({ permission: false })
  getWorkflowCapabilities(): Promise<WorkflowCapabilitiesDto> {
    return this.service.capabilities();
  }

  @Post('preview')
  @Authenticated({ permission: Permission.WorkflowRead })
  previewWorkflow(@Auth() auth: AuthDto, @Body() dto: WorkflowPreviewDto): Promise<WorkflowPreviewResponseDto> {
    return this.service.preview(auth, dto);
  }

  @Post(':id/batches')
  @Authenticated({ permission: Permission.WorkflowUpdate })
  runWorkflow(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<WorkflowBatchResponseDto> {
    return this.service.runBatch(auth, id);
  }

  @Get(':id/batches')
  @Authenticated({ permission: Permission.WorkflowRead })
  getWorkflowBatches(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<WorkflowBatchResponseDto[]> {
    return this.service.getBatches(auth, id);
  }

  @Get(':id/batches/:batchId')
  @Authenticated({ permission: Permission.WorkflowRead })
  getWorkflowBatch(
    @Auth() auth: AuthDto,
    @Param() { id, batchId }: WorkflowBatchParamsDto,
  ): Promise<WorkflowBatchResponseDto> {
    return this.service.getBatch(auth, id, batchId);
  }

  @Post(':id/batches/:batchId/cancel')
  @Authenticated({ permission: Permission.WorkflowUpdate })
  cancelWorkflowBatch(
    @Auth() auth: AuthDto,
    @Param() { id, batchId }: WorkflowBatchParamsDto,
  ): Promise<WorkflowBatchResponseDto> {
    return this.service.cancelBatch(auth, id, batchId);
  }

  @Get(':id')
  @Authenticated({ permission: Permission.WorkflowRead })
  @Endpoint({
    summary: 'Retrieve a workflow',
    description: 'Retrieve information about a specific workflow by its ID.',
    history: HistoryBuilder.v3(),
  })
  getWorkflow(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<WorkflowResponseDto> {
    return this.service.get(auth, id);
  }

  @Get(':id/share')
  @Authenticated({ permission: Permission.WorkflowRead })
  @Endpoint({
    summary: 'Retrieve a workflow',
    description: 'Retrieve a workflow details without ids, default values, etc.',
    history: HistoryBuilder.v3(),
  })
  getWorkflowForShare(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<WorkflowShareResponseDto> {
    return this.service.share(auth, id);
  }

  @Put(':id')
  @Authenticated({ permission: Permission.WorkflowUpdate })
  @Endpoint({
    summary: 'Update a workflow',
    description:
      'Update the information of a specific workflow by its ID. This endpoint can be used to update the workflow name, description, trigger type, filters and actions order, etc.',
    history: new HistoryBuilder().added('v3.0.0').deprecated('v3', { replacementId: 'updateWorkflow' }),
  })
  updateWorkflow(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: WorkflowUpdateDto,
  ): Promise<WorkflowResponseDto> {
    return this.service.update(auth, id, dto);
  }

  @Patch(':id')
  @ApiExcludeEndpoint()
  @Authenticated({ permission: Permission.WorkflowUpdate })
  updateWorkflowV3(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: WorkflowUpdateDto,
  ): Promise<WorkflowResponseDto> {
    return this.service.update(auth, id, dto);
  }

  @Delete(':id')
  @Authenticated({ permission: Permission.WorkflowDelete })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Delete a workflow',
    description: 'Delete a workflow by its ID.',
    history: HistoryBuilder.v3(),
  })
  deleteWorkflow(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<void> {
    return this.service.delete(auth, id);
  }

  @Post(':id/runs/:runId/retry')
  @Authenticated({ permission: Permission.WorkflowUpdate })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Retry a workflow run',
    description:
      'Run a logged workflow run again, as its next attempt, for the photo or video that started it. The workflow must be enabled and able to run.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  retryWorkflowRun(@Auth() auth: AuthDto, @Param() { id, runId }: WorkflowRunParamsDto): Promise<void> {
    return this.service.retryRun(auth, id, runId);
  }

  @Get(':id/logs')
  @Authenticated({ permission: Permission.WorkflowLogs })
  @Endpoint({
    summary: 'Retrieve workflow logs',
    description: 'Retrieve logs of a workflows runs by ID',
    history: HistoryBuilder.v3(),
  })
  getWorkflowLogs(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Query() dto: WorkflowGetLogsDto,
  ): Promise<WorkflowLogEntryDto[]> {
    return this.service.getLogs(auth, id, dto);
  }
}
