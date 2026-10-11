import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import {
  StudioSourceResolutionDto,
  StudioSourceResolutionRequestDto,
  StudioSourceResolutionSchema,
} from 'src/dtos/studio-source-resolution.dto.js';
import {
  StudioSourceResolutionRepository,
  type StudioSourceAdmission,
} from 'src/repositories/studio-source-resolution.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { AssetMediaService } from 'src/services/asset-media.service.js';
import { StudioProjectService } from 'src/services/studio-project.service.js';
import { StudioResourceService, type StudioAuthorizedEntry } from 'src/services/studio-resource.service.js';
import {
  classifyStudioLottieParent,
  materializeStudioLottieSource,
  readStudioVectorBindings,
  validateStudioLottieItem,
  type StudioLottieSource,
} from 'src/utils/studio-lottie-source.js';
import { canonicalJson } from 'src/utils/studio-project.js';

const MAX_DECODED = 16 * 1024 * 1024;
const MAX_BASE64 = 24 * 1024 * 1024;
const MAX_ALLOCATED = 32 * 1024 * 1024;
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new BadRequestException('studio_source_invalid');
  return value as Record<string, unknown>;
};

/** Canonical closed bytes for one exact saved source. It exposes no engine/provider capability. */
@Injectable()
export class StudioSourceResolutionService {
  constructor(
    private projects: StudioProjectService,
    private resources: StudioResourceService,
    private admission: StudioSourceResolutionRepository,
    private storage: StorageRepository,
    private media: AssetMediaService,
  ) {}

  async resolve(
    auth: AuthDto,
    projectId: string,
    dto: StudioSourceResolutionRequestDto,
  ): Promise<StudioSourceResolutionDto> {
    if (!auth.session || auth.sharedLink || auth.apiKey || auth.system)
      throw new NotFoundException('Studio source unavailable');
    const snapshots = new Set<Uint8Array>();
    let parsed: StudioLottieSource | undefined;
    const identities = new Map<string, string>();
    const cached = new Map<string, Uint8Array>();
    const identity = (info: Awaited<ReturnType<StorageRepository['stat']>>) => {
      if (!info.isFile()) throw new ConflictException('studio_source_superseded');
      return [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(':');
    };
    let allocated = 0;
    const own = (bytes: Uint8Array) => {
      snapshots.add(bytes);
      allocated += bytes.byteLength;
      if (allocated > MAX_ALLOCATED) throw new PayloadTooLargeException('studio_source_allocation_limit');
      return bytes;
    };
    try {
      const authorized = await this.projects.authorizeRevision(auth, { projectId });
      if (
        authorized.revision.revision !== dto.revision ||
        authorized.revision.digest !== dto.graphDigest ||
        sha256(canonicalJson(authorized.envelope)) !== dto.graphDigest
      )
        throw new ConflictException('studio_source_superseded');
      this.resources.assertAuthorizedManifest(authorized.manifest);
      const graph = record(authorized.envelope.graph);
      const timeline = record(graph.timeline);
      if (
        !Array.isArray(timeline.items) ||
        (timeline.compositions !== undefined && !Array.isArray(timeline.compositions))
      )
        throw new BadRequestException('studio_source_invalid');
      const views = [timeline, ...((timeline.compositions as unknown[]) ?? []).map(record)];
      const uses = views.flatMap((view) => {
        if (!Array.isArray(view.items)) throw new BadRequestException('studio_source_invalid');
        return view.items.map(record).filter((item) => item.type === 'lottie' && item.mediaId === dto.parent.id);
      });
      if (
        !uses.length ||
        !uses.some((item) => item.animationId === dto.selection.animationId && item.themeId === dto.selection.themeId)
      )
        throw new BadRequestException('studio_source_invalid_selection');
      const roots = authorized.manifest.entries.filter((entry) => entry.id === dto.parent.id);
      if (
        roots.length !== 1 ||
        roots[0].kind !== dto.parent.kind ||
        roots[0].checksum !== dto.parent.checksum ||
        !roots[0].path
      )
        throw new ConflictException('studio_source_superseded');
      const bindings = readStudioVectorBindings(graph);
      if (
        bindings.some(
          (binding) =>
            binding.parent.id === dto.parent.id &&
            (binding.parent.kind !== dto.parent.kind || binding.parent.checksum !== dto.parent.checksum),
        )
      )
        throw new ConflictException('studio_source_superseded');
      const keys = new Set([
        roots[0].key,
        ...bindings
          .filter((binding) => binding.parent.id === dto.parent.id)
          .map((binding) => `${binding.child.kind}:${binding.child.id}`),
      ]);
      const inputs = authorized.manifest.entries.filter((entry) => keys.has(entry.key));
      if (inputs.length !== keys.size || new Set(inputs.map((entry) => entry.key)).size !== inputs.length)
        throw new NotFoundException('Studio source unavailable');
      const grants = this.resources.issueReadGrants(authorized.manifest, {
        workerId: 'studio-source-resolution',
        ttlSeconds: 5,
      });
      const expiresAt = Math.min(
        Date.now() + 5000,
        Date.parse(authorized.manifest.expiresAt),
        ...grants.filter((grant) => keys.has(grant.key)).map((grant) => Date.parse(grant.expiresAt)),
      );
      const admission: StudioSourceAdmission = {
        projectId,
        revision: dto.revision,
        graphDigest: dto.graphDigest,
        manifest: authorized.manifest,
        inputs,
        expiresAt,
      };
      const guard = async () => {
        const live = await this.admission.guard(auth, admission);
        if (
          Date.now() >= expiresAt ||
          (live.session?.expiresAt && new Date(live.session.expiresAt).getTime() <= Date.now()) ||
          (live.session?.hasElevatedPermission &&
            (!live.session.pinExpiresAt || new Date(live.session.pinExpiresAt).getTime() <= Date.now()))
        )
          throw new ConflictException('studio_source_expired');
        return live;
      };
      const read = async (entry: StudioAuthorizedEntry, maximum: number): Promise<Uint8Array> => {
        let live = await guard();
        const grant = grants.find((grant) => grant.key === entry.key);
        if (!grant || !entry.path) throw new NotFoundException('Studio source unavailable');
        const verified = await this.resources.verifyReadGrant(grant.token, {
          workerId: 'studio-source-resolution',
          auth: live,
        });
        live = await guard();
        if (!verified.valid || (verified.path && verified.path !== entry.path))
          throw new NotFoundException('Studio source unavailable');
        if (entry.sourceAccess === 'owner' || entry.sourceAccess === 'shared') {
          const original = await this.media.downloadOriginal(live, entry.id, { edited: false });
          try {
            await guard();
            if (original.path !== entry.path) throw new ConflictException('studio_source_superseded');
          } finally {
            original.release?.();
          }
        }
        const observed = await this.storage.stat(entry.path);
        await guard();
        const boundIdentity = identity(observed);
        if (identities.has(entry.key) && identities.get(entry.key) !== boundIdentity)
          throw new ConflictException('studio_source_superseded');
        identities.set(entry.key, boundIdentity);
        if (cached.has(entry.key)) return cached.get(entry.key)!;
        const file = await this.storage.openForRandomRead(entry.path);
        try {
          await guard();
          if (
            !Number.isSafeInteger(file.size) ||
            file.size <= 0 ||
            file.size > Math.min(maximum, MAX_DECODED, MAX_ALLOCATED - allocated)
          )
            throw new PayloadTooLargeException('studio_source_allocation_limit');
          const bytes = own(await file.read(0, file.size));
          await guard();
          if (bytes.length !== file.size) throw new ConflictException('studio_source_superseded');
          const expected = entry.checksum ?? '';
          const hex = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(expected);
          const checksum = Buffer.from(expected, hex ? 'hex' : 'base64');
          try {
            if (
              ![20, 32].includes(checksum.length) ||
              (!hex && checksum.toString('base64') !== expected) ||
              !createHash(checksum.length === 20 ? 'sha1' : 'sha256')
                .update(bytes)
                .digest()
                .equals(checksum)
            )
              throw new ConflictException('studio_source_superseded');
          } finally {
            checksum.fill(0);
          }
          cached.set(entry.key, bytes);
          return bytes;
        } finally {
          await file.close();
          await guard();
        }
      };
      await guard();
      const parent = await read(roots[0], MAX_DECODED);
      await guard();
      if (sha256(parent) !== dto.parent.checksum) throw new ConflictException('studio_source_superseded');
      const type = classifyStudioLottieParent(parent);
      if (type.kind !== 'vector') throw new BadRequestException('studio_source_invalid');
      parsed = await materializeStudioLottieSource(
        graph,
        dto.parent,
        parent,
        type.contentType,
        inputs,
        (input, maximum) =>
          read(
            inputs.find((entry) => entry.key === input.key)!,
            maximum,
          ),
        (bytes) => {
          snapshots.add(bytes);
        },
      );
      await guard();
      // Each authored root and composition use keeps its own selection and metadata, before deduplication.
      for (const item of uses) validateStudioLottieItem(parsed, item);
      const files = parsed.archive?.files ?? {
        'animation.json': bindings.some((binding) => binding.parent.id === dto.parent.id)
          ? own(Buffer.from(JSON.stringify(parsed.documents[0].document)))
          : parent,
      };
      if (Object.keys(files).length > 256) throw new PayloadTooLargeException('studio_source_allocation_limit');
      let decoded = 0;
      let encoded = 0;
      const output = Object.entries(files)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([path, bytes]) => {
          snapshots.add(bytes);
          decoded += bytes.byteLength;
          encoded += 4 * Math.ceil(bytes.byteLength / 3);
          if (decoded > MAX_DECODED || encoded > MAX_BASE64)
            throw new PayloadTooLargeException('studio_source_allocation_limit');
          return {
            path,
            sha256: sha256(bytes),
            base64: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64'),
          };
        });
      const result = {
        projectId,
        revision: dto.revision,
        graphDigest: dto.graphDigest,
        parent: dto.parent,
        expiresAt: new Date(expiresAt).toISOString(),
        archive: !!parsed.archive,
        files: output,
        selection: dto.selection,
      };
      const manifestDigest = sha256(
        canonicalJson({ ...result, files: output.map(({ path, sha256 }) => ({ path, sha256 })) }),
      );
      // Actual original admission is repeated at the final boundary, after materialization and encoding.
      for (const input of inputs.filter((entry) => entry.sourceAccess === 'owner' || entry.sourceAccess === 'shared')) {
        const live = await guard();
        const original = await this.media.downloadOriginal(live, input.id, { edited: false });
        try {
          await guard();
          if (original.path !== input.path) throw new ConflictException('studio_source_superseded');
        } finally {
          original.release?.();
        }
      }
      for (const input of inputs) {
        const current = await this.storage.stat(input.path!);
        await guard();
        if (identity(current) !== identities.get(input.key)) throw new ConflictException('studio_source_superseded');
      }
      await guard();
      return StudioSourceResolutionSchema.parse({ ...result, manifestDigest });
    } catch (error) {
      if (
        error instanceof ConflictException ||
        error instanceof NotFoundException ||
        error instanceof PayloadTooLargeException
      )
        throw error;
      throw new BadRequestException('studio_source_invalid');
    } finally {
      for (const bytes of Object.values(parsed?.archive?.files ?? {})) bytes.fill(0);
      for (const bytes of snapshots) bytes.fill(0);
    }
  }
}
