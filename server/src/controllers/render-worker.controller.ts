import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Next,
  Param,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import { ApiHeader, ApiTags } from '@nestjs/swagger';
import { type NextFunction, type Response } from 'express';
import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  RenderWorkerAdmissionDto,
  RenderWorkerAuditDto,
  RenderWorkerAuditSearchDto,
  RenderWorkerCancelAckDto,
  RenderWorkerCheckpointCompleteDto,
  RenderWorkerCheckpointPlanDto,
  RenderWorkerClaimDto,
  RenderWorkerClaimRequestDto,
  RenderWorkerCompatibilityResponseDto,
  RenderWorkerCompleteDto,
  RenderWorkerCreateDto,
  RenderWorkerCreateResponseDto,
  RenderWorkerDto,
  RenderWorkerFailDto,
  RenderWorkerHeartbeatDto,
  RenderWorkerHeartbeatResponseDto,
  RenderWorkerLimitDto,
  RenderWorkerLimitUpdateDto,
  RenderWorkerLimitsResponseDto,
  RenderWorkerProgressDto,
  RenderWorkerRemoteReferenceDto,
  RenderWorkerSessionDto,
  RenderWorkerUpdateDto,
  RenderWorkerWriteResultDto,
} from 'src/dtos/render-worker.dto.js';
import { ApiTag, ImmichHeader } from 'src/enum.js';
import { Auth, Authenticated, FileResponse, HomeNetworkOnly } from 'src/middleware/auth.guard.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { RenderWorkerService } from 'src/services/render-worker.service.js';
import { sendFile } from 'src/utils/file.js';
import { UUIDParamDto, UUIDv7ParamDto } from 'src/validation.js';

const OperationInputParamSchema = z.object({
  id: z.uuidv7(),
  grant: z.string().min(1).max(8192),
});
class OperationInputParamDto extends createZodDto(OperationInputParamSchema) {}

const CheckpointParamSchema = z.object({
  id: z.uuidv7(),
  sequence: z.coerce.number().int().min(0),
});
class CheckpointParamDto extends createZodDto(CheckpointParamSchema) {}

const history = () => new HistoryBuilder().added('v3.0.0').alpha('v3.0.0');

/**
 * Administration of render workers (FL-95). Under `admin/`, so every route is administrator-only
 * and the controller index test enforces it. Nothing here returns a secret after creation and
 * nothing here returns anybody's media.
 */
@ApiTags(ApiTag.RenderWorkers)
@Controller('admin/render-workers')
export class RenderWorkerAdminController {
  constructor(private service: RenderWorkerService) {}

  @Get()
  @Authenticated({ admin: true })
  @Endpoint({
    summary: 'List render workers',
    description: 'Every enrolled worker identity with its destination, scopes, ceilings and current load.',
    history: history(),
  })
  listRenderWorkers(): Promise<RenderWorkerDto[]> {
    return this.service.list();
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Authenticated({ admin: true })
  @Endpoint({
    summary: 'Enrol a render worker',
    description:
      'Creates a worker identity and returns its enrolment secret once. The server stores only a hash; the secret cannot be recovered later.',
    history: history(),
  })
  createRenderWorker(
    @Auth() auth: AuthDto,
    @Body() dto: RenderWorkerCreateDto,
  ): Promise<RenderWorkerCreateResponseDto> {
    return this.service.create(auth, dto);
  }

  @Get('limits')
  @Authenticated({ admin: true })
  @Endpoint({
    summary: 'Get render limits',
    description:
      'The instance default and every per-account ceiling on concurrent operations, wall-clock and output size.',
    history: history(),
  })
  getRenderWorkerLimits(): Promise<RenderWorkerLimitsResponseDto> {
    return this.service.getLimits();
  }

  @Put('limits')
  @Authenticated({ admin: true })
  @Endpoint({
    summary: 'Set render limits',
    description: 'Sets the instance default when `userId` is omitted, otherwise the ceiling for one account.',
    history: history(),
  })
  updateRenderWorkerLimits(
    @Auth() auth: AuthDto,
    @Body() dto: RenderWorkerLimitUpdateDto,
  ): Promise<RenderWorkerLimitDto> {
    return this.service.updateLimits(auth, dto);
  }

  @Delete('limits/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Authenticated({ admin: true })
  @Endpoint({
    summary: 'Remove an account’s render limits',
    description: 'The account falls back to the instance default.',
    history: history(),
  })
  deleteRenderWorkerUserLimit(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<void> {
    return this.service.deleteUserLimit(auth, id);
  }

  @Get('audit')
  @Authenticated({ admin: true })
  @Endpoint({
    summary: 'Search the render worker audit trail',
    description:
      'Enrolments, admissions, refusals, limit breaches and revocations, newest first. Never a secret or a path.',
    history: history(),
  })
  searchRenderWorkerAudit(@Query() dto: RenderWorkerAuditSearchDto): Promise<RenderWorkerAuditDto[]> {
    return this.service.searchAudit(dto);
  }

  @Get('compatibility')
  @Authenticated({ admin: true })
  @Endpoint({
    summary: 'Get render worker compatibility',
    description:
      'Which render kinds a qualified GPU worker (live session, fresh conformance, pinned engine) can take right now.',
    history: history(),
  })
  getRenderWorkerCompatibility(): Promise<RenderWorkerCompatibilityResponseDto> {
    return this.service.getCompatibility();
  }

  @Get(':id')
  @Authenticated({ admin: true })
  @Endpoint({
    summary: 'Get a render worker',
    description: 'One worker identity with its current load.',
    history: history(),
  })
  getRenderWorker(@Param() { id }: UUIDv7ParamDto): Promise<RenderWorkerDto> {
    return this.service.get(id);
  }

  @Put(':id')
  @Authenticated({ admin: true })
  @Endpoint({
    summary: 'Update a render worker',
    description: 'Changes the name, scopes, required engine digest and ceilings. A revoked worker cannot be changed.',
    history: history(),
  })
  updateRenderWorker(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDv7ParamDto,
    @Body() dto: RenderWorkerUpdateDto,
  ): Promise<RenderWorkerDto> {
    return this.service.update(auth, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Authenticated({ admin: true })
  @Endpoint({
    summary: 'Revoke a render worker',
    description:
      'Revokes the identity and every session it holds. Claims it held expire into the recovery pass; the record is kept for the audit trail.',
    history: history(),
  })
  revokeRenderWorker(@Auth() auth: AuthDto, @Param() { id }: UUIDv7ParamDto): Promise<void> {
    return this.service.revoke(auth, id);
  }
}

const WorkerSessionHeader = () =>
  ApiHeader({
    name: ImmichHeader.RenderWorkerSession,
    description: 'The session credential issued by admission',
    required: true,
  });

/**
 * The worker-facing surface (FL-95) over FL-104's durable operations.
 *
 * These routes are not user routes: they are declared `public` to the user auth guard and are
 * authenticated by the worker session header inside the service on every call. Every write also
 * carries the claim token in its body and is bound to the worker the session belongs to, so a
 * worker can only touch operations it claimed, and can only read their inputs through the grants
 * it was handed with the claim.
 */
@ApiTags(ApiTag.RenderWorkers)
@Controller('render-workers')
// FL-161: render workers run on the home network. Their API, including the original inputs they read
// through claim grants, is refused over remote access whatever allowOriginalsOverRelay says.
@HomeNetworkOnly()
export class RenderWorkerController {
  constructor(
    private service: RenderWorkerService,
    private logger: LoggingRepository,
  ) {
    this.logger.setContext(RenderWorkerController.name);
  }

  @Post('admission')
  @HttpCode(HttpStatus.CREATED)
  @Authenticated({ public: true })
  @Endpoint({
    summary: 'Admit a render worker',
    description:
      'Exchanges the enrolment secret and fresh conformance evidence for a scoped, expiring session credential. Refusals are audited and answered generically.',
    history: history(),
  })
  admitRenderWorker(@Body() dto: RenderWorkerAdmissionDto): Promise<RenderWorkerSessionDto> {
    return this.service.admit(dto);
  }

  @Post('claims')
  @HttpCode(HttpStatus.OK)
  @WorkerSessionHeader()
  @Authenticated({ public: true })
  @Endpoint({
    summary: 'Claim the next admitted operation',
    description:
      'Returns the oldest queued operation this worker is admitted to run, with its claim token, checkpoints and short-lived input grants. Answers 204 when nothing is admissible.',
    history: history(),
  })
  async claimRenderOperation(
    @Headers(ImmichHeader.RenderWorkerSession) session: string | undefined,
    @Body() dto: RenderWorkerClaimRequestDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RenderWorkerClaimDto | undefined> {
    const claim = await this.service.claim(session, dto);
    if (!claim) {
      res.status(HttpStatus.NO_CONTENT);
    }
    return claim;
  }

  @Post('operations/:id/heartbeat')
  @HttpCode(HttpStatus.OK)
  @WorkerSessionHeader()
  @Authenticated({ public: true })
  @Endpoint({
    summary: 'Heartbeat a claimed operation',
    description:
      'Extends the lease, enforces the wall-clock and output ceilings and reports whether the owner asked to cancel.',
    history: history(),
  })
  heartbeatRenderOperation(
    @Headers(ImmichHeader.RenderWorkerSession) session: string | undefined,
    @Param() { id }: UUIDv7ParamDto,
    @Body() dto: RenderWorkerHeartbeatDto,
  ): Promise<RenderWorkerHeartbeatResponseDto> {
    return this.service.heartbeat(session, id, dto);
  }

  @Post('operations/:id/progress')
  @HttpCode(HttpStatus.OK)
  @WorkerSessionHeader()
  @Authenticated({ public: true })
  @Endpoint({
    summary: 'Report progress on a claimed operation',
    description: 'Counted units only; the percentage is derived on the server.',
    history: history(),
  })
  reportRenderOperationProgress(
    @Headers(ImmichHeader.RenderWorkerSession) session: string | undefined,
    @Param() { id }: UUIDv7ParamDto,
    @Body() dto: RenderWorkerProgressDto,
  ): Promise<RenderWorkerWriteResultDto> {
    return this.service.progress(session, id, dto);
  }

  @Post('operations/:id/checkpoints')
  @HttpCode(HttpStatus.OK)
  @WorkerSessionHeader()
  @Authenticated({ public: true })
  @Endpoint({
    summary: 'Plan a render checkpoint',
    description: 'Records a chunk and every digest that identifies it. Re-planning a sequence replaces its identity.',
    history: history(),
  })
  planRenderCheckpoint(
    @Headers(ImmichHeader.RenderWorkerSession) session: string | undefined,
    @Param() { id }: UUIDv7ParamDto,
    @Body() dto: RenderWorkerCheckpointPlanDto,
  ): Promise<RenderWorkerWriteResultDto> {
    return this.service.planCheckpoint(session, id, dto);
  }

  @Post('operations/:id/checkpoints/:sequence/complete')
  @HttpCode(HttpStatus.OK)
  @WorkerSessionHeader()
  @Authenticated({ public: true })
  @Endpoint({
    summary: 'Complete a render checkpoint',
    description:
      'Marks a planned chunk rendered. The chunk key must still match; a re-planned chunk cannot be completed.',
    history: history(),
  })
  completeRenderCheckpoint(
    @Headers(ImmichHeader.RenderWorkerSession) session: string | undefined,
    @Param() { id, sequence }: CheckpointParamDto,
    @Body() dto: RenderWorkerCheckpointCompleteDto,
  ): Promise<RenderWorkerWriteResultDto> {
    return this.service.completeCheckpoint(session, id, sequence, dto);
  }

  @Post('operations/:id/validate')
  @HttpCode(HttpStatus.OK)
  @WorkerSessionHeader()
  @Authenticated({ public: true })
  @Endpoint({
    summary: 'Begin validating a claimed operation',
    description: 'Moves the operation to `validating`. Nothing is published until `complete`.',
    history: history(),
  })
  validateRenderOperation(
    @Headers(ImmichHeader.RenderWorkerSession) session: string | undefined,
    @Param() { id }: UUIDv7ParamDto,
    @Body() dto: RenderWorkerCompleteDto,
  ): Promise<RenderWorkerWriteResultDto> {
    return this.service.beginValidation(session, id, dto);
  }

  @Post('operations/:id/complete')
  @HttpCode(HttpStatus.OK)
  @WorkerSessionHeader()
  @Authenticated({ public: true })
  @Endpoint({
    summary: 'Complete a claimed operation',
    description:
      'Publishes a validated result under the same claim. A previous valid result is kept until this succeeds.',
    history: history(),
  })
  completeRenderOperation(
    @Headers(ImmichHeader.RenderWorkerSession) session: string | undefined,
    @Param() { id }: UUIDv7ParamDto,
    @Body() dto: RenderWorkerCompleteDto,
  ): Promise<RenderWorkerWriteResultDto> {
    return this.service.complete(session, id, dto);
  }

  @Post('operations/:id/fail')
  @HttpCode(HttpStatus.OK)
  @WorkerSessionHeader()
  @Authenticated({ public: true })
  @Endpoint({
    summary: 'Fail a claimed operation',
    description: 'Records a stable error code and operator detail. A finished operation is not reopened.',
    history: history(),
  })
  failRenderOperation(
    @Headers(ImmichHeader.RenderWorkerSession) session: string | undefined,
    @Param() { id }: UUIDv7ParamDto,
    @Body() dto: RenderWorkerFailDto,
  ): Promise<RenderWorkerWriteResultDto> {
    return this.service.fail(session, id, dto);
  }

  @Post('operations/:id/cancel-ack')
  @HttpCode(HttpStatus.OK)
  @WorkerSessionHeader()
  @Authenticated({ public: true })
  @Endpoint({
    summary: 'Acknowledge a cancellation',
    description: 'The worker confirms it stopped. Only then does the operation become `cancelled`.',
    history: history(),
  })
  acknowledgeRenderCancel(
    @Headers(ImmichHeader.RenderWorkerSession) session: string | undefined,
    @Param() { id }: UUIDv7ParamDto,
    @Body() dto: RenderWorkerCancelAckDto,
  ): Promise<RenderWorkerWriteResultDto> {
    return this.service.acknowledgeCancel(session, id, dto);
  }

  @Get('remote-references')
  @WorkerSessionHeader()
  @Authenticated({ public: true })
  @Endpoint({
    summary: 'List what this worker must stop or delete',
    description:
      'Studio export renders that were cancelled or abandoned and copies of outputs this worker kept. Each stays listed until the worker acknowledges it.',
    history: history(),
  })
  getRenderRemoteReferences(
    @Headers(ImmichHeader.RenderWorkerSession) session: string | undefined,
  ): Promise<RenderWorkerRemoteReferenceDto[]> {
    return this.service.listRemoteReferences(session);
  }

  @Post('remote-references/:id/acknowledge')
  @HttpCode(HttpStatus.OK)
  @WorkerSessionHeader()
  @Authenticated({ public: true })
  @Endpoint({
    summary: 'Acknowledge a remote reference',
    description: 'The worker confirms the render is stopped, or the copy deleted, and nothing of it remains.',
    history: history(),
  })
  acknowledgeRenderRemoteReference(
    @Headers(ImmichHeader.RenderWorkerSession) session: string | undefined,
    @Param() { id }: UUIDv7ParamDto,
  ): Promise<RenderWorkerWriteResultDto> {
    return this.service.acknowledgeRemoteReference(session, id);
  }

  @Get('operations/:id/inputs/:grant')
  @FileResponse()
  @WorkerSessionHeader()
  @Authenticated({ public: true })
  @Endpoint({
    summary: 'Read an operation input',
    description:
      'Streams one input under a grant issued with the claim. The grant is bound to this operation, this claim and this session, and owner access is re-checked on every read.',
    history: history(),
  })
  async readRenderOperationInput(
    @Headers(ImmichHeader.RenderWorkerSession) session: string | undefined,
    @Param() { id, grant }: OperationInputParamDto,
    @Res() res: Response,
    @Next() next: NextFunction,
  ) {
    await sendFile(res, next, () => this.service.readInput(session, id, grant), this.logger);
  }
}
