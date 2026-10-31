import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { MediaOperationDestination, MediaOperationKind, MediaOperationStatus } from 'src/enum.js';
import { MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { StudioProjectRepository } from 'src/repositories/studio-project.repository.js';
import { StudioProjectService } from 'src/services/studio-project.service.js';
import { StudioResourceService } from 'src/services/studio-resource.service.js';
import { StudioReverseConformService } from 'src/services/studio-reverse-conform.service.js';
import { Rational } from 'src/utils/rational-time.js';
import { validateStudioCommandEnvelope } from 'src/utils/studio-commands.js';
import { StudioDestination, StudioResourceKind, isStudioIdentifier, isStudioUuid } from 'src/utils/studio-resources.js';
import { relinkReverseClip, reverseClipOf } from 'src/utils/studio-reverse-clip.js';

/** Internal command boundary. Browser delivery and the host action are separate qualification gates. */
@Injectable()
export class StudioReverseConformCommandService {
  constructor(
    private studio: StudioProjectService,
    private projects: StudioProjectRepository,
    private producer: StudioReverseConformService,
    private operations: MediaOperationRepository,
    private resources: StudioResourceService,
  ) {}

  async enqueue(auth: AuthDto, projectId: string, clientId: string, command: unknown) {
    this.requireEditor(auth, projectId, clientId);
    const checked = validateStudioCommandEnvelope(command);
    if (!checked.valid || checked.envelope.id !== 'job.enqueueReverseConform') {
      throw new BadRequestException('Expected the canonical job.enqueueReverseConform command');
    }
    const { envelope } = checked;
    if (envelope.payload.destinationId !== StudioDestination.Local) {
      throw new BadRequestException('Reverse conform supports only the local destination');
    }
    await this.studio.requireOwnedProject(auth, projectId, 'Only the project owner can conform a clip');
    const source = await this.studio.authorizeRevision(auth, {
      projectId,
      revision: envelope.revision,
      destination: StudioDestination.Local,
    });
    if (source.project.ownerId !== auth.user.id) {
      throw new ForbiddenException('Only the project owner can conform a clip');
    }
    const clipId = envelope.payload.clipId as string;
    const clip = reverseClipOf(source.envelope.graph, clipId);
    // No implicit takeover. The producer atomically checks this lease and revision again on insert.
    await this.studio.acquireLease(auth, projectId, { clientId });
    return this.producer.enqueueSource(auth, {
      projectId,
      revision: envelope.revision,
      sourceKey: `library-asset:${clip.assetId}`,
      destination: StudioDestination.Local,
      command: { clipId, clientId, requestKey: envelope.idempotencyKey },
    });
  }

  /** Applying is a separate edit: an asynchronous job never silently takes over or overwrites an editor. */
  async apply(auth: AuthDto, projectId: string, clientId: string, operationId: string) {
    this.requireEditor(auth, projectId, clientId);
    if (!isStudioUuid(operationId)) {
      throw new BadRequestException('Invalid reverse-conform operation');
    }
    const operation = await this.operations.getForOwner(operationId, auth.user.id);
    if (
      !operation ||
      operation.ownerId !== auth.user.id ||
      operation.projectId !== projectId ||
      operation.kind !== MediaOperationKind.StudioReverseConform
    ) {
      throw new NotFoundException('Reverse-conform operation not found');
    }
    const snapshot = operation.snapshot as Record<string, unknown>;
    const result = operation.result as Record<string, unknown> | null;
    if (
      operation.status !== MediaOperationStatus.Completed ||
      operation.destination !== MediaOperationDestination.Local ||
      snapshot?.kind !== 'studio-source-reverse' ||
      snapshot.projectId !== projectId ||
      !isStudioIdentifier(snapshot.clipId) ||
      !Number.isSafeInteger(snapshot.revision) ||
      (snapshot.revision as number) < 1 ||
      result?.kind !== 'studio-source-reverse' ||
      result.generatedId !== `reverse-${operationId}` ||
      result.sourceRevision !== snapshot.revision ||
      result.sourceRevisionDigest !== snapshot.digest ||
      result.sourceKey !== snapshot.sourceKey ||
      result.sourceLevel !== true ||
      result.requiresClipRelink !== true
    ) {
      throw new ConflictException('The operation has no applicable completed source conform');
    }
    const source = await this.studio.authorizeRevision(auth, {
      projectId,
      revision: snapshot.revision as number,
      destination: StudioDestination.Local,
    });
    if (
      source.project.ownerId !== auth.user.id ||
      source.project.archivedAt ||
      source.revision.digest !== snapshot.digest
    ) {
      throw new ConflictException('The source project or revision changed');
    }
    const clip = reverseClipOf(source.envelope.graph, snapshot.clipId);
    if (`library-asset:${clip.assetId}` !== snapshot.sourceKey) {
      throw new ConflictException('The result does not belong to this clip source');
    }
    const generatedId = result.generatedId as string;
    const declarations = await this.projects.listGeneratedResources(projectId);
    const generated = declarations.find((entry) => entry.id === generatedId);
    if (
      !generated ||
      generated.producer !== 'reverse-conform' ||
      !generated.derivedFrom.includes(snapshot.sourceKey as string)
    ) {
      throw new ConflictException('The generated source declaration is unavailable');
    }
    const graph = relinkReverseClip(
      source.envelope.graph,
      snapshot.clipId,
      {
        frames: result.frames as number,
        frameRate: result.frameRate as Rational,
      },
      generatedId,
    );
    // A generated declaration is not an access grant. Resolve the entire prospective graph and its lineage now.
    const resolution = await this.resources.resolveProjectResources(auth, {
      projectId,
      ownerId: auth.user.id,
      revision: snapshot.revision as number,
      graph,
      imports: await this.projects.listImportDeclarations(projectId),
      generated: declarations,
      destination: StudioDestination.Local,
    });
    if (
      !resolution.manifest.complete ||
      resolution.manifest.entries.every(
        (entry) => entry.key !== snapshot.sourceKey || entry.checksum !== snapshot.checksum,
      ) ||
      resolution.manifest.entries.every(
        (entry) =>
          entry.kind !== StudioResourceKind.GeneratedIntermediate ||
          entry.id !== generatedId ||
          entry.checksum !== generated.checksum,
      )
    ) {
      throw new ForbiddenException('The conformed clip sources are no longer available');
    }
    await this.studio.acquireLease(auth, projectId, { clientId });
    return this.studio.save(auth, projectId, {
      clientId,
      expectedRevision: snapshot.revision as number,
      requestKey: `reverse-apply-${operationId}`,
      envelope: { ...source.envelope, graph },
      summary: { counts: { 'source.reverseConform': 1 }, total: 1 },
    });
  }

  private requireEditor(auth: AuthDto, projectId: string, clientId: string) {
    if (auth.sharedLink) {
      throw new ForbiddenException('Shared links cannot conform Studio clips');
    }
    if (!isStudioUuid(projectId) || !isStudioIdentifier(clientId)) {
      throw new BadRequestException('Reverse conform requires a project and editor instance');
    }
  }
}
