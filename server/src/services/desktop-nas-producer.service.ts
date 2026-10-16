import { ConflictException, Injectable } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import z from 'zod';
import type { Transaction } from 'kysely';
import type { DB } from 'src/schema/index.js';
import { MlDestinationKind, MlWorkload } from 'src/enum.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { DesktopClipIndexRepository } from 'src/repositories/desktop-clip-index.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MachineLearningRepository } from 'src/repositories/machine-learning.repository.js';
import { MlDestinationRepository } from 'src/repositories/ml-destination.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { getConfig } from 'src/utils/config.js';
import { parseDesktopClipSpaces } from 'src/utils/desktop-clip-space.js';
import { faceEntries } from 'src/utils/desktop-face.js';
import { parseDesktopModelCatalogue } from 'src/utils/desktop-model-catalogue.js';
import { parseBoundFaceResult } from 'src/utils/face-result.js';
import { selectMlDestination } from 'src/utils/ml-destination.js';
import { canonicalJson } from 'src/utils/object.js';

@Injectable()
export class DesktopNasProducerService {
  private logger = LoggingRepository.create(DesktopNasProducerService.name);
  private models = parseDesktopModelCatalogue(
    JSON.parse(readFileSync(join(import.meta.dirname, '../../resources/desktop/model-catalogue.json'), 'utf8')),
  );
  private spaces = parseDesktopClipSpaces(
    JSON.parse(readFileSync(join(import.meta.dirname, '../../resources/desktop/model-spaces.json'), 'utf8')),
    this.models,
  );
  constructor(
    private machineLearning: MachineLearningRepository,
    private destinations: MlDestinationRepository,
    private index: DesktopClipIndexRepository,
    private configRepo: ConfigRepository,
    private metadataRepo: SystemMetadataRepository,
  ) {}

  async verifyFace(modelKey: string) {
    const profile = this.models.profiles.find(
      (profile) => profile.workload === 'face' && profile.modelKey === modelKey,
    );
    if (!profile) throw new ConflictException('desktop_face_profile_unavailable');
    const snapshot = async (tx?: Transaction<DB>) => {
      const config = await getConfig(
        {
          configRepo: this.configRepo,
          metadataRepo: tx ? new SystemMetadataRepository(tx) : this.metadataRepo,
          logger: this.logger,
        },
        { withCache: false },
      );
      if (
        !config.machineLearning.enabled ||
        !config.machineLearning.facialRecognition.enabled ||
        canonicalJson(faceEntries(config.machineLearning.facialRecognition)) !== canonicalJson(profile.spec.entries)
      )
        throw new ConflictException('desktop_nas_model_unavailable');
      const route = (await (tx ? new MlDestinationRepository(tx) : this.destinations).getRouteStates()).find(
        (route) => route.workload === MlWorkload.Face,
      );
      if (route?.origin !== 'default' || !route.destinationId || !route.revisionId)
        throw new ConflictException('desktop_route_review_required');
      return { route, face: config.machineLearning.facialRecognition, urls: config.machineLearning.urls };
    };
    const initial = await snapshot();
    const identity = canonicalJson(initial);
    const selection = await selectMlDestination(
      { mlDestinationRepository: this.destinations, machineLearningRepository: this.machineLearning },
      { workload: MlWorkload.Face, destinationId: initial.route.destinationId! },
    );
    if (![MlDestinationKind.Local, MlDestinationKind.Lan].includes(selection.kind) || selection.endpoint.cloud)
      throw new ConflictException('desktop_pool_destination_changed');
    const assertCurrent = async (tx?: Transaction<DB>) => {
      if (canonicalJson(await snapshot(tx)) !== identity) throw new ConflictException('desktop_nas_producer_changed');
      await selection.endpoint.assertAuthority?.();
    };
    await assertCurrent();
    const root = await mkdtemp(join(tmpdir(), 'frameleaf-nas-face-producer-'));
    try {
      const path = join(root, 'fixture.png');
      await writeFile(path, Buffer.from(profile.fixtureBase64, 'base64'), { mode: 0o600, flag: 'wx' });
      const actual = parseBoundFaceResult(await this.machineLearning.detectBoundFaces(selection, path, profile));
      const expected = parseBoundFaceResult(profile.spec.expectedOutput);
      const close = (left: number, right: number) =>
        Math.abs(left - right) <= Math.max(1e-4, 1e-3 * Math.max(Math.abs(left), Math.abs(right)));
      const faces = actual['facial-recognition'];
      const golden = expected['facial-recognition'];
      if (
        actual.imageWidth !== expected.imageWidth ||
        actual.imageHeight !== expected.imageHeight ||
        faces.length !== golden.length ||
        faces.some((face, i) => {
          const vector: number[] = JSON.parse(face.embedding);
          const reference: number[] = JSON.parse(golden[i].embedding);
          return (
            !close(face.score, golden[i].score) ||
            vector.some((v, j) => !close(v, reference[j])) ||
            (['x1', 'x2', 'y1', 'y2'] as const).some((key) => !close(face.boundingBox[key], golden[i].boundingBox[key]))
          );
        })
      )
        throw new ConflictException('desktop_nas_fixture_mismatch');
      await assertCurrent();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
    const verifiedAt = Date.now();
    return Object.freeze({
      modelKeys: Object.freeze([profile.modelKey]),
      selection,
      destinationId: selection.destinationId,
      routeRevisionId: initial.route.revisionId!,
      verifiedAt,
      assertCurrent: async (tx?: Transaction<DB>) => {
        if (Date.now() < verifiedAt || Date.now() - verifiedAt > 60_000)
          throw new ConflictException('desktop_nas_producer_expired');
        await assertCurrent(tx);
      },
    });
  }

  /** Verifies synthetic fixtures only; this neither admits an index nor grants worker scope. */
  async verify(spaceKey: string) {
    const space = this.spaces.spaces.find((s) => s.spaceKey === spaceKey);
    if (!space) throw new ConflictException('desktop_clip_space_unavailable');
    const modelKeys = [space.visualModelKey, ...space.textModelKeys];
    const profiles = modelKeys.map((key) => this.models.profiles.find((p) => p.modelKey === key)!);
    const snapshot = async (tx?: Transaction<DB>) => {
      const config = await getConfig(
        {
          configRepo: this.configRepo,
          metadataRepo: tx ? new SystemMetadataRepository(tx) : this.metadataRepo,
          logger: this.logger,
        },
        { withCache: false },
      );
      if (
        !config.machineLearning.enabled ||
        !config.machineLearning.clip.enabled ||
        profiles.some((p) => p.modelName !== config.machineLearning.clip.modelName)
      )
        throw new ConflictException('desktop_nas_model_unavailable');
      const route = (await (tx ? new MlDestinationRepository(tx) : this.destinations).getRouteStates()).find(
        (r) => r.workload === MlWorkload.Clip,
      );
      if (!route || route.origin !== 'default' || !route.destinationId || !route.revisionId)
        throw new ConflictException('desktop_route_review_required');
      const active = tx ? await this.index.getActive(tx) : await this.index.getActive();
      if (active && active.space.spaceKey !== spaceKey) throw new ConflictException('desktop_clip_index_changed');
      return {
        route,
        clip: config.machineLearning.clip,
        urls: config.machineLearning.urls,
        revisionId: active?.revisionId ?? null,
      };
    };
    const initial = await snapshot();
    const identity = canonicalJson(initial);
    const selection = await selectMlDestination(
      { mlDestinationRepository: this.destinations, machineLearningRepository: this.machineLearning },
      { workload: MlWorkload.Clip, destinationId: initial.route.destinationId! },
    );
    const assertCurrent = async () => {
      if (canonicalJson(await snapshot()) !== identity) throw new ConflictException('desktop_nas_producer_changed');
      await selection.endpoint.assertAuthority?.();
    };
    await assertCurrent();
    const root = await mkdtemp(join(tmpdir(), 'frameleaf-nas-producer-'));
    try {
      for (const profile of profiles) {
        if (profile.workload !== 'clip' || profile.embeddingDimensions === undefined)
          throw new ConflictException('desktop_clip_profile_unavailable');
        await assertCurrent();
        const bytes = Buffer.from(profile.fixtureBase64, 'base64');
        const path = join(root, 'fixture.png');
        const image = profile.spec.fixtureKind === 'image';
        if (image) await writeFile(path, bytes, { mode: 0o600, flag: 'wx' });
        const result = await this.machineLearning.encodeBoundClip(
          selection,
          image ? { imagePath: path } : { text: bytes.toString('utf8') },
          profile,
        );
        const vector = z
          .array(z.number().finite())
          .length(profile.embeddingDimensions)
          .parse(JSON.parse(result.embedding));
        const expected: number[] = JSON.parse(String(profile.spec.expectedOutput.clip));
        if (
          result.modelKey !== profile.modelKey ||
          vector.some(
            (v, i) => Math.abs(v - expected[i]) > Math.max(1e-4, 1e-3 * Math.max(Math.abs(v), Math.abs(expected[i]))),
          )
        )
          throw new ConflictException('desktop_nas_fixture_mismatch');
        await assertCurrent();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
    const verifiedAt = Date.now();
    return Object.freeze({
      spaceKey,
      modelKeys: Object.freeze(modelKeys),
      destinationId: selection.destinationId,
      routeRevisionId: initial.route.revisionId!,
      selection,
      verifiedAt,
      assertCurrent: async (tx?: Transaction<DB>) => {
        if (Date.now() < verifiedAt || Date.now() - verifiedAt > 60_000)
          throw new ConflictException('desktop_nas_producer_expired');
        if (tx) {
          if (canonicalJson(await snapshot(tx)) !== identity)
            throw new ConflictException('desktop_nas_producer_changed');
          await selection.endpoint.assertAuthority?.();
        } else await assertCurrent();
      },
    });
  }
}
