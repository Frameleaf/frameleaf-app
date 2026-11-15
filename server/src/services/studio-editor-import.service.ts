import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { extname } from 'node:path';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { InterchangeProject, MediaReference } from 'src/utils/studio-interchange/model.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { OnEvent } from 'src/decorators.js';
import {
  StudioEditorImportBuild,
  StudioEditorImportBuildSchema,
  StudioEditorImportCheck,
  StudioEditorImportCheckSchema,
  StudioEditorImportCreateDto,
  StudioEditorImportDto,
  StudioEditorImportProjectNotesDto,
  StudioEditorImportQueuedDto,
  StudioEditorImportStartDto,
  StudioEditorImportStartedDto,
  StudioEditorImportUploadDto,
} from 'src/dtos/studio-editor-import.dto.js';
import {
  FrameleafWorker,
  MediaOperationDestination,
  MediaOperationKind,
  MediaOperationStatus,
  StorageFolder,
} from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaOperation, MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { StudioEditorImportRepository } from 'src/repositories/studio-editor-import.repository.js';
import { StudioBundleUpload, StudioProjectRepository } from 'src/repositories/studio-project.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { AlbumService } from 'src/services/album.service.js';
import { AssetMediaService } from 'src/services/asset-media.service.js';
import { StudioBundleService } from 'src/services/studio-bundle.service.js';
import { StudioCatalogService } from 'src/services/studio-catalog.service.js';
import { ZipByteSource, ZipEntry, digestZipEntry } from 'src/utils/studio-bundle.js';
import { STUDIO_ENGINE_REVISION } from 'src/utils/studio-commands.generated.js';
import { studioBundledFontFamilies } from 'src/utils/studio-fonts.js';
import { InterchangeLoss, InterchangeMedia, mapInterchangeTimeline } from 'src/utils/studio-interchange/map.js';
import {
  InterchangeCandidate,
  STUDIO_EDITOR_APP_NAMES,
  interchangeMediaFiles,
  matchInterchangeFile,
  studioEditorImportDigest,
} from 'src/utils/studio-interchange/media.js';
import { InterchangeReadError } from 'src/utils/studio-interchange/readers/common.js';
import {
  INTERCHANGE_EXTENSIONS,
  INTERCHANGE_SIDECAR_EXTENSIONS,
  InterchangeReadResult,
  extensionOf,
  readInterchangeFile,
} from 'src/utils/studio-interchange/readers/index.js';
import { exactRate } from 'src/utils/studio-interchange/readers/otio.js';
import {
  STUDIO_ENGINE,
  STUDIO_ENVELOPE_SCHEMA_VERSION,
  checkStudioEnvelope,
  studioEnvelopeDigest,
} from 'src/utils/studio-project.js';
import { isStudioUuid } from 'src/utils/studio-resources.js';

const LEASE_MS = 120_000;
const TICK_MS = 5000;
const UPLOAD_KIND = 'studio-editor-import';
const MAX_SIDECAR_BYTES = 64 * 1024 * 1024;
/** Progress through a job: reading, finding media, building, checking. */
const PROGRESS = { reading: 0, media: 30, building: 60, checking: 90 } as const;
/** Codes that depend on the media the person picks; the check leaves them to the media list. */
const MEDIA_CODES = new Set(['media-missing', 'media-shorter']);

type MediaChoice = { key: string; assetId: string | null; how: 'found' | 'matched' | 'added' | 'carried' | 'none' };
type Snapshot = {
  kind: 'studio-editor-import';
  stage: 'check' | 'build';
  uploadId: string;
  sidecarUploadIds: string[];
  fileName: string;
  frameRate: number | null;
  /** Build only. */
  timeline?: number;
  media?: MediaChoice[];
  albumName?: string;
};
type Job = { operation: MediaOperation; claimToken: string };

class ImportRefusal extends Error {}

export const studioEditorImportStep = (
  status: MediaOperationStatus,
  progress: number,
): StudioEditorImportDto['step'] => {
  if (status === MediaOperationStatus.Completed) {
    return 'done';
  }
  if (progress >= PROGRESS.checking) {
    return 'checking';
  }
  if (progress >= PROGRESS.building) {
    return 'building';
  }
  return progress >= PROGRESS.media ? 'media' : 'reading';
};

const notesOf = (losses: readonly InterchangeLoss[], fps: number) =>
  losses.map((loss) => ({
    code: loss.code,
    clip: loss.clip,
    what: loss.what,
    became: loss.became,
    atSeconds: Math.round((loss.at / fps) * 1000) / 1000,
  }));

/** The key a project uses for a carried file may be a path or a URL; match it to an archive entry. */
const carriedEntry = (carried: Map<string, ZipEntry>, key: string) => {
  let path = key;
  try {
    path = decodeURIComponent(key.replace(/^file:\/\/(localhost)?/, ''));
  } catch {
    // Keep the key as written.
  }
  return carried.get(path) ?? carried.get(path.replace(/^\.?\//, ''));
};

/**
 * Import a project from another video editor (FL-1542, FL-1543; approved mock 2026-11-13).
 *
 * 1. The person uploads the project file, and any CDL or LUT files beside it.
 * 2. A `check` job reads it (FL-1546, FL-1547) and finds each file it uses in the library: exact bytes
 *    for media carried in the archive, then name, length and dimensions. The person sees what comes
 *    over and confirms matches; files that are not in the library they send from their own folder.
 * 3. Starting the import queues one `build` job per timeline picked. Each adds carried media to the
 *    library, maps the timeline to a Studio graph (FL-1541) and saves it as a new project, idempotent
 *    on its job id. Files the person sent and carried files land in an album named after the project.
 *
 * Everything is the owner's alone: anyone else is told the job does not exist.
 */
@Injectable()
export class StudioEditorImportService {
  private readonly workerId = `studio-editor-import-${randomUUID()}`;
  private stopping = false;
  private timer?: ReturnType<typeof setInterval>;
  private active?: Promise<void>;

  constructor(
    private logger: LoggingRepository,
    private operations: MediaOperationRepository,
    private projects: StudioProjectRepository,
    private repository: StudioEditorImportRepository,
    private bundles: StudioBundleService,
    private catalog: StudioCatalogService,
    private assetMedia: AssetMediaService,
    private albums: AlbumService,
    private users: UserRepository,
    private storage: StorageRepository,
  ) {
    this.logger.setContext(StudioEditorImportService.name);
  }

  private requireOwner(auth: AuthDto) {
    if (auth.sharedLink) {
      throw new NotFoundException('Not found');
    }
  }

  /** Keep an uploaded project, CDL or LUT file for the import; anything else is removed. */
  async registerUpload(
    auth: AuthDto,
    file: Express.Multer.File | undefined,
    reservationId: string | undefined,
  ): Promise<StudioEditorImportUploadDto> {
    this.requireOwner(auth);
    const upload = reservationId ? await this.projects.getUpload(reservationId, auth.user.id) : undefined;
    try {
      if (!file?.path || !upload || upload.path !== file.path) {
        throw new BadRequestException('Choose a project file to upload');
      }
      const fileName = file.originalname.split(/[/\\]/).at(-1)?.slice(0, 255) || 'project';
      const extension = extensionOf(fileName);
      if (
        !(INTERCHANGE_EXTENSIONS as readonly string[]).includes(extension) &&
        !(INTERCHANGE_SIDECAR_EXTENSIONS as readonly string[]).includes(extension)
      ) {
        throw new BadRequestException(
          'Frameleaf reads Final Cut Pro XML, Final Cut Pro 7 XML, OpenTimelineIO and EDL projects, with CDL and LUT files',
        );
      }
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(file.path)) {
        hash.update(chunk as Buffer);
      }
      const finalized = await this.projects.finalizeUpload(upload.id, {
        ownerId: auth.user.id,
        path: upload.path,
        sizeBytes: file.size,
        digest: hash.digest('hex'),
        originalFileName: fileName,
        manifest: { kind: UPLOAD_KIND },
        expiresAt: new Date(upload.expiresAt),
      });
      return { id: finalized.id, fileName, sizeBytes: file.size };
    } catch (error) {
      if (upload) {
        await this.bundles.abortUpload(auth, upload.id, true);
      }
      throw error;
    }
  }

  private async getImportUpload(ownerId: string, id: string, as: 'project' | 'sidecar'): Promise<StudioBundleUpload> {
    const upload = await this.projects.getUpload(id, ownerId);
    const extension = extensionOf(upload?.originalFileName ?? '');
    const allowed: readonly string[] = as === 'project' ? INTERCHANGE_EXTENSIONS : INTERCHANGE_SIDECAR_EXTENSIONS;
    if (
      !upload ||
      upload.manifest?.kind !== UPLOAD_KIND ||
      !upload.digest ||
      new Date(upload.expiresAt).getTime() <= Date.now() ||
      !allowed.includes(extension)
    ) {
      throw new BadRequestException(
        as === 'project'
          ? 'That project file is no longer here; upload it again'
          : 'A CDL or LUT file is no longer here',
      );
    }
    return upload;
  }

  async create(auth: AuthDto, dto: StudioEditorImportCreateDto): Promise<StudioEditorImportQueuedDto> {
    this.requireOwner(auth);
    const upload = await this.getImportUpload(auth.user.id, dto.uploadId, 'project');
    const sidecarUploadIds = [...new Set(dto.sidecarUploadIds)];
    for (const id of sidecarUploadIds) {
      await this.getImportUpload(auth.user.id, id, 'sidecar');
    }
    const snapshot: Snapshot = {
      kind: 'studio-editor-import',
      stage: 'check',
      uploadId: upload.id,
      sidecarUploadIds,
      fileName: upload.originalFileName,
      frameRate: dto.frameRate ?? null,
    };
    const operation = await this.queue(auth.user.id, snapshot, upload.originalFileName);
    return { id: operation.id, status: operation.status };
  }

  private queue(ownerId: string, snapshot: Snapshot, label: string) {
    return this.operations.create({
      ownerId,
      kind: MediaOperationKind.StudioEditorImport,
      destination: MediaOperationDestination.Local,
      destinationDetail: null,
      label,
      assetId: null,
      resultAssetId: null,
      retryOfId: null,
      projectId: null,
      revisionId: null,
      snapshot,
      settings: { stage: snapshot.stage },
      estimate: null,
      totalUnits: 100,
      maxAttempts: 2,
    });
  }

  async get(auth: AuthDto, id: string): Promise<StudioEditorImportDto> {
    const operation = auth.sharedLink ? undefined : await this.operations.getForOwner(id, auth.user.id);
    if (!operation || operation.kind !== MediaOperationKind.StudioEditorImport) {
      throw new NotFoundException('Import not found');
    }
    const snapshot = this.snapshot(operation);
    const done = operation.status === MediaOperationStatus.Completed;
    const check =
      done && snapshot.stage === 'check' ? StudioEditorImportCheckSchema.safeParse(operation.result) : undefined;
    const build =
      done && snapshot.stage === 'build' ? StudioEditorImportBuildSchema.safeParse(operation.result) : undefined;
    return {
      id: operation.id,
      status: operation.status,
      stage: snapshot.stage,
      step: studioEditorImportStep(operation.status, operation.progress),
      progress: operation.progress,
      error: operation.error ?? null,
      check: check?.success ? check.data : null,
      build: build?.success ? build.data : null,
    };
  }

  /** Build the timelines the person picked, with the media they chose. */
  async start(auth: AuthDto, id: string, dto: StudioEditorImportStartDto): Promise<StudioEditorImportStartedDto> {
    const found = await this.get(auth, id);
    if (found.stage !== 'check' || !found.check) {
      throw new BadRequestException('This import has not finished checking the project yet');
    }
    const check = found.check;
    const operation = (await this.operations.getForOwner(id, auth.user.id))!;
    const snapshot = this.snapshot(operation);
    await this.getImportUpload(auth.user.id, snapshot.uploadId, 'project');
    const timelines = [...new Set(dto.timelines)];
    if (timelines.some((index) => check.timelines.every((timeline) => timeline.index !== index))) {
      throw new BadRequestException('Pick timelines from this project');
    }
    const chosen = new Map(dto.media.map((item) => [item.key, item]));
    const wanted = [...new Set(dto.media.flatMap((item) => (item.assetId ? [item.assetId] : [])))];
    const usable = await this.repository.getUsable(auth.user.id, wanted);
    if (wanted.some((assetId) => !usable.has(assetId))) {
      throw new BadRequestException('A chosen file is not in your library');
    }
    const media: MediaChoice[] = check.media.map((file) => {
      const choice = chosen.get(file.key);
      if (choice) {
        return {
          key: file.key,
          assetId: choice.assetId,
          how: !choice.assetId
            ? file.carried
              ? 'carried'
              : 'none'
            : choice.added
              ? 'added'
              : choice.assetId === file.assetId && file.match === 'found'
                ? 'found'
                : 'matched',
        };
      }
      if (file.match === 'found' && file.assetId) {
        return { key: file.key, assetId: file.assetId, how: 'found' };
      }
      return { key: file.key, assetId: null, how: file.carried ? 'carried' : 'none' };
    });
    const jobs: StudioEditorImportStartedDto['jobs'] = [];
    for (const timeline of timelines) {
      const queued = await this.queue(
        auth.user.id,
        { ...snapshot, stage: 'build', timeline, media, ...(dto.albumName && { albumName: dto.albumName }) },
        check.timelines.find((item) => item.index === timeline)!.name,
      );
      jobs.push({ id: queued.id, timeline, status: queued.status });
    }
    return { jobs };
  }

  /** The notes of a project this import built, for the editor (FL-1545). Owner only. */
  async getProjectNotes(auth: AuthDto, projectId: string): Promise<StudioEditorImportProjectNotesDto> {
    this.requireOwner(auth);
    const project = await this.projects.getById(projectId);
    const operation =
      project?.ownerId === auth.user.id && project.importOperationId
        ? await this.operations.getForOwner(project.importOperationId, auth.user.id)
        : undefined;
    const build =
      operation?.kind === MediaOperationKind.StudioEditorImport
        ? StudioEditorImportBuildSchema.safeParse(operation.result)
        : undefined;
    if (!build?.success) {
      throw new NotFoundException('This project was not imported from another editor');
    }
    const { source, fileName, notes, notices } = build.data;
    return { source, fileName, notes, notices };
  }

  @OnEvent({ name: 'AppBootstrap', workers: [FrameleafWorker.Microservices] })
  onBootstrap() {
    this.stopping = false;
    this.timer ??= setInterval(() => this.tick(), TICK_MS);
    this.tick();
  }

  @OnEvent({ name: 'AppShutdown' })
  async onShutdown() {
    this.stopping = true;
    clearInterval(this.timer);
    this.timer = undefined;
    await this.active;
  }

  tick() {
    if (this.active || this.stopping) {
      return;
    }
    this.active = this.drain()
      .catch((error) => this.logger.warn(`Editor import worker failed: ${error}`))
      .finally(() => {
        this.active = undefined;
      });
  }

  async drain() {
    while (!this.stopping) {
      const job = await this.operations.claimNext({
        kinds: [MediaOperationKind.StudioEditorImport],
        workerId: this.workerId,
        leaseMs: LEASE_MS,
      });
      if (!job) {
        return;
      }
      await this.run(job);
    }
  }

  async run({ operation, claimToken }: Job): Promise<void> {
    if (!isStudioUuid(operation.id) || !isStudioUuid(operation.ownerId) || !isStudioUuid(claimToken)) {
      return;
    }
    const step = async (value: number) => {
      const ok =
        (await this.operations.heartbeat(operation.id, claimToken, LEASE_MS)) &&
        (await this.operations.reportProgress(operation.id, claimToken, {
          status: MediaOperationStatus.Rendering,
          processedUnits: value,
          totalUnits: 100,
          progress: value,
        }));
      const held = await this.operations.getForWorker(operation.id);
      if (!ok || held?.status === MediaOperationStatus.Cancelling) {
        throw new Error('Claim lost or cancelled');
      }
    };
    try {
      const snapshot = this.snapshot(operation);
      const auth = await this.owner(operation.ownerId);
      await step(PROGRESS.reading);
      const result =
        snapshot.stage === 'check'
          ? await this.check(auth, snapshot, step)
          : await this.build(auth, operation, snapshot, step);
      if (!(await this.operations.beginValidation(operation.id, claimToken, true))) {
        throw new Error('Claim lost');
      }
      if (!(await this.operations.complete(operation.id, claimToken, { resultAssetId: null, progress: 100, result }))) {
        throw new Error('Claim lost before the import was recorded');
      }
    } catch (error) {
      const held = await this.operations.getForWorker(operation.id);
      if (held?.claimToken === claimToken && held.status === MediaOperationStatus.Cancelling) {
        await this.operations.acknowledgeCancel(operation.id, claimToken, { released: true });
        return;
      }
      const refused =
        error instanceof ImportRefusal || error instanceof InterchangeReadError || error instanceof BadRequestException;
      await this.operations.fail(
        operation.id,
        claimToken,
        {
          errorCode: refused ? 'studio_editor_import_refused' : 'studio_editor_import_failed',
          error: refused ? (error as Error).message : 'The project could not be imported',
        },
        { retry: !refused },
      );
      if (!refused) {
        this.logger.warn(`Editor import ${operation.id} failed: ${error}`);
      }
    }
  }

  /** Read the project file and its sidecars, then hand the open archive to `use`. */
  private async read<T>(
    ownerId: string,
    snapshot: Snapshot,
    use: (read: InterchangeReadResult, source: ZipByteSource, digest: string) => Promise<T>,
  ): Promise<T> {
    const upload = await this.getImportUpload(ownerId, snapshot.uploadId, 'project').catch(() => {
      throw new ImportRefusal('The project file is no longer here; upload it again');
    });
    const sidecars = [];
    for (const id of snapshot.sidecarUploadIds) {
      const sidecar = await this.getImportUpload(ownerId, id, 'sidecar').catch(() => null);
      if (sidecar && Number(sidecar.sizeBytes) <= MAX_SIDECAR_BYTES) {
        sidecars.push({ name: sidecar.originalFileName, bytes: await this.storage.readFile(sidecar.path) });
      }
    }
    const file = await this.storage.openForRandomRead(upload.path);
    try {
      const source = { size: file.size, read: file.read };
      const read = await readInterchangeFile(snapshot.fileName, source, {
        sidecars,
        ...(snapshot.frameRate && { rate: exactRate(snapshot.frameRate) }),
      });
      return await use(read, source, upload.digest);
    } finally {
      await file.close();
    }
  }

  private async check(auth: AuthDto, snapshot: Snapshot, step: (value: number) => Promise<void>) {
    return this.read(auth.user.id, snapshot, async ({ project, carried }, source) => {
      await step(PROGRESS.media);
      const files = interchangeMediaFiles(project);
      // Tier 1: the exact bytes of media carried inside the archive.
      const digests = new Map<string, string>();
      for (const file of files) {
        const entry = carriedEntry(carried, file.key);
        if (entry) {
          digests.set(file.key, (await digestZipEntry(source, entry)).sha256);
        }
      }
      const exact = await this.repository.getByChecksums(
        auth.user.id,
        digests
          .values()
          .map((digest) => Buffer.from(digest, 'hex'))
          .toArray(),
      );
      // Tiers 2 and 3: the name, with the length and dimensions, then the same name re-encoded.
      const candidates = await this.repository.getCandidates(
        auth.user.id,
        files.map((file) => file.name),
      );
      const media = files.map((file) => {
        const digest = digests.get(file.key);
        const byBytes = digest ? exact.get(digest) : undefined;
        const match = byBytes
          ? { status: 'found' as const, assetId: byBytes, assetName: file.name, confidence: 1 }
          : matchInterchangeFile(file, candidates);
        return {
          key: file.key,
          name: file.name,
          kind: file.kind ?? null,
          clips: file.clips,
          match: match.status,
          confidence: match.confidence,
          assetId: match.assetId,
          assetName: match.assetName,
          carried: !!digest,
        };
      });
      await step(PROGRESS.building);
      const timelines = project.timelines.map((timeline, index) => {
        const { graph, losses } = mapInterchangeTimeline(
          timeline,
          this.mapOptions(project, `check:${index}`, () => null),
        );
        const fps = graph.metadata.fps;
        const types = graph.timeline.items.map((item) => item.type);
        return {
          index,
          name: timeline.name,
          durationSeconds: graph.duration,
          clips: types.filter((type) => ['video', 'image', 'composition'].includes(type)).length,
          transitions: graph.timeline.transitions?.length ?? 0,
          titles: types.filter((type) => type === 'text').length,
          sound: types.filter((type) => type === 'audio').length,
          markers: graph.timeline.markers?.length ?? 0,
          notes: notesOf(
            losses.filter((loss) => !MEDIA_CODES.has(loss.code)),
            fps,
          ),
        };
      });
      const check: StudioEditorImportCheck = {
        fileName: snapshot.fileName,
        source: project.source,
        sourceVersion: project.sourceVersion ?? null,
        notices: project.notices ?? [],
        timelines,
        media,
      };
      return StudioEditorImportCheckSchema.parse(check) as unknown as Record<string, unknown>;
    });
  }

  private mapOptions(
    project: InterchangeProject,
    seed: string,
    resolveMedia: (reference: Extract<MediaReference, { kind: 'external' }>) => InterchangeMedia | null,
  ) {
    return {
      source: project.source,
      seed,
      now: Date.now(),
      resolveMedia,
      fonts: new Set<string>(studioBundledFontFamilies().map((family) => family.family)),
    };
  }

  private async build(
    auth: AuthDto,
    operation: MediaOperation,
    snapshot: Snapshot,
    step: (value: number) => Promise<void>,
  ) {
    return this.read(auth.user.id, snapshot, async ({ project, carried }, source, digest) => {
      const timeline = project.timelines[snapshot.timeline ?? -1];
      if (!timeline) {
        throw new ImportRefusal('That timeline is no longer in the project file');
      }
      await step(PROGRESS.media);
      const choices = new Map((snapshot.media ?? []).map((choice) => [choice.key, choice]));
      const files = interchangeMediaFiles({ ...project, timelines: [timeline] });
      const resolved = new Map<string, string>();
      const counts = { found: 0, matched: 0, added: 0, placeholders: 0, total: files.length };
      const added: string[] = [];
      for (const file of files) {
        const choice = choices.get(file.key);
        let assetId = choice?.assetId ?? null;
        let how = choice?.how ?? 'none';
        const entry = carriedEntry(carried, file.key);
        if (!assetId && entry) {
          assetId = await this.addCarried(auth, source, entry, file.name);
          how = 'carried';
        }
        if (!assetId) {
          counts.placeholders++;
          continue;
        }
        resolved.set(file.key, assetId);
        if (how === 'added' || how === 'carried') {
          counts.added++;
          added.push(assetId);
        } else if (how === 'found') {
          counts.found++;
        } else {
          counts.matched++;
        }
      }
      const usable = await this.repository.getUsableFacts(auth.user.id, [...new Set(resolved.values())]);
      const facts = new Map<string, InterchangeMedia>();
      for (const [key, assetId] of resolved) {
        const known = usable.get(assetId);
        if (known) {
          facts.set(
            key,
            await this.factsOf(
              auth,
              known,
              files.find((file) => file.key === key),
            ),
          );
        }
      }
      // A file chosen earlier that has since gone from the library becomes a placeholder.
      counts.placeholders += resolved.size - facts.size;
      for (const [key, assetId] of resolved) {
        if (!facts.has(key)) {
          resolved.delete(key);
          if (added.includes(assetId)) {
            counts.added--;
          } else if (choices.get(key)?.how === 'found') {
            counts.found--;
          } else {
            counts.matched--;
          }
        }
      }

      await step(PROGRESS.building);
      const { graph, losses } = mapInterchangeTimeline(
        timeline,
        this.mapOptions(project, `editor-import:${operation.id}`, (reference) => facts.get(reference.key) ?? null),
      );
      const envelope = {
        schemaVersion: STUDIO_ENVELOPE_SCHEMA_VERSION,
        engine: STUDIO_ENGINE,
        engineRevision: STUDIO_ENGINE_REVISION,
        graph,
      };
      const checked = checkStudioEnvelope(envelope);
      if (!checked.ok) {
        throw new ImportRefusal(`The imported project is too large or not valid: ${checked.detail}`);
      }

      await step(PROGRESS.checking);
      const name = timeline.name.trim().slice(0, 200) || 'Imported project';
      const { project: saved } = await this.projects.createWithRevision({
        ownerId: auth.user.id,
        name,
        importedFromDigest: studioEditorImportDigest(project.source, digest),
        importOperationId: operation.id,
        revision: {
          authorId: auth.user.id,
          envelope: checked.envelope as unknown as Record<string, unknown>,
          digest: studioEnvelopeDigest(checked.envelope),
          graphBytes: checked.graphBytes,
          summary: { counts: { 'project.importEditor': 1 }, total: 1 },
          requestKey: `editor-import:${operation.id}`,
        },
      });
      if (added.length > 0) {
        // The files the person sent and those the archive carried, together, named after the project.
        const app = STUDIO_EDITOR_APP_NAMES[project.source];
        const albumName = snapshot.albumName ?? (app ? `${name} (from ${app})` : `${name} (imported)`);
        await this.albums.create(auth, { albumName, assetIds: [...new Set(added)] }).catch((error: unknown) => {
          this.logger.warn(`Editor import ${operation.id}: the album could not be made: ${error}`);
        });
      }
      const fps = graph.metadata.fps;
      const build: StudioEditorImportBuild = {
        projectId: saved.id,
        name,
        source: project.source,
        fileName: snapshot.fileName,
        timeline: snapshot.timeline!,
        notes: notesOf(losses, fps),
        notices: project.notices ?? [],
        media: counts,
      };
      return StudioEditorImportBuildSchema.parse(build) as unknown as Record<string, unknown>;
    });
  }

  /** What the mapper needs about a library item; for a file just added, what the project said. */
  private async factsOf(
    auth: AuthDto,
    known: InterchangeCandidate,
    file: ReturnType<typeof interchangeMediaFiles>[number] | undefined,
  ): Promise<InterchangeMedia> {
    const kind = known.kind === 'other' ? (file?.kind ?? 'video') : known.kind;
    const fallback: InterchangeMedia = {
      assetId: known.id,
      kind,
      width: known.width ?? file?.width ?? 0,
      height: known.height ?? file?.height ?? 0,
      fps: 0,
      frameCount: null,
      durationSeconds: known.durationSeconds ?? file?.durationSeconds ?? 0,
    };
    try {
      const facts = await this.catalog.getMediaFacts(auth, known.id);
      return {
        ...fallback,
        width: facts.width ?? fallback.width,
        height: facts.height ?? fallback.height,
        fps: facts.fps ?? 0,
        frameCount: facts.frameCount ?? null,
        durationSeconds: facts.durationSeconds || fallback.durationSeconds,
      };
    } catch {
      return fallback;
    }
  }

  /** Media carried inside the archive, added to the library the way a Takeout import adds a photo. */
  private async addCarried(
    auth: AuthDto,
    source: ZipByteSource,
    entry: ZipEntry,
    name: string,
  ): Promise<string | null> {
    const destination = StorageCore.getNestedPath(
      StorageFolder.Upload,
      auth.user.id,
      `${randomUUID()}${extname(name).toLowerCase()}`,
    );
    this.storage.mkdirSync(StorageCore.getNestedFolder(StorageFolder.Upload, auth.user.id, destination));
    const sha1 = createHash('sha1');
    const output = this.storage.createWriteStream(destination);
    try {
      const { sha256, bytes } = await digestZipEntry(source, entry, {
        onData: async (chunk) => {
          sha1.update(chunk);
          if (!output.write(chunk)) {
            await new Promise<void>((resolve) => output.once('drain', () => resolve()));
          }
        },
      });
      await new Promise<void>((resolve, reject) =>
        output.end((error?: Error | null) => (error ? reject(error) : resolve())),
      );
      const now = new Date();
      const response = await this.assetMedia.uploadAsset(
        auth,
        { filename: name, fileCreatedAt: now, fileModifiedAt: now },
        {
          uuid: randomUUID(),
          checksum: Buffer.from(sha256, 'hex'),
          legacyChecksum: sha1.digest(),
          originalPath: destination,
          originalName: name,
          size: bytes,
        },
      );
      return response.id;
    } catch (error) {
      output.destroy();
      await this.storage.unlink(destination).catch(() => {});
      this.logger.warn(`Editor import: ${name} from the archive could not be added: ${error}`);
      return null;
    }
  }

  private snapshot(operation: MediaOperation): Snapshot {
    const snapshot = operation.snapshot as Partial<Snapshot> | null;
    if (
      snapshot?.kind !== 'studio-editor-import' ||
      (snapshot.stage !== 'check' && snapshot.stage !== 'build') ||
      typeof snapshot.uploadId !== 'string' ||
      typeof snapshot.fileName !== 'string' ||
      !Array.isArray(snapshot.sidecarUploadIds)
    ) {
      throw new ImportRefusal('Invalid import snapshot');
    }
    return snapshot as Snapshot;
  }

  private async owner(ownerId: string): Promise<AuthDto> {
    const user = await this.users.get(ownerId, { withDeleted: false });
    if (!user) {
      throw new ImportRefusal('The import’s owner is unavailable');
    }
    // The owner's submitted background job, like Make a movie.
    return {
      user: {
        id: user.id,
        isAdmin: user.isAdmin,
        name: user.name,
        email: user.email,
        quotaUsageInBytes: user.quotaUsageInBytes,
        quotaSizeInBytes: user.quotaSizeInBytes,
      },
      session: { id: this.workerId, hasElevatedPermission: false },
    };
  }
}
