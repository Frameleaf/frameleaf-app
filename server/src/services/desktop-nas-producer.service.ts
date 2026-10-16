import { ConflictException, Injectable } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import z from 'zod';
import { MlWorkload } from 'src/enum.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { DesktopClipIndexRepository } from 'src/repositories/desktop-clip-index.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MachineLearningRepository } from 'src/repositories/machine-learning.repository.js';
import { MlDestinationRepository } from 'src/repositories/ml-destination.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { getConfig } from 'src/utils/config.js';
import { parseDesktopClipSpaces } from 'src/utils/desktop-clip-space.js';
import { parseDesktopModelCatalogue } from 'src/utils/desktop-model-catalogue.js';
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

  /** Verifies synthetic fixtures only; this neither admits an index nor grants worker scope. */
  async verify(spaceKey: string) {
    const space = this.spaces.spaces.find((s) => s.spaceKey === spaceKey);
    if (!space) throw new ConflictException('desktop_clip_space_unavailable');
    const modelKeys = [space.visualModelKey, ...space.textModelKeys];
    const profiles = modelKeys.map((key) => this.models.profiles.find((p) => p.modelKey === key)!);
    const snapshot = async () => {
      const config = await getConfig(
        { configRepo: this.configRepo, metadataRepo: this.metadataRepo, logger: this.logger },
        { withCache: false },
      );
      if (
        !config.machineLearning.enabled ||
        !config.machineLearning.clip.enabled ||
        profiles.some((p) => p.modelName !== config.machineLearning.clip.modelName)
      )
        throw new ConflictException('desktop_nas_model_unavailable');
      const route = (await this.destinations.getRouteStates()).find((r) => r.workload === MlWorkload.Clip);
      if (!route || route.origin !== 'default' || !route.destinationId || !route.revisionId)
        throw new ConflictException('desktop_route_review_required');
      const active = await this.index.getActive();
      if (active && active.space.spaceKey !== spaceKey) throw new ConflictException('desktop_clip_index_changed');
      return { route, clip: config.machineLearning.clip, revisionId: active?.revisionId ?? null };
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
      verifiedAt,
      assertCurrent: async () => {
        if (Date.now() < verifiedAt || Date.now() - verifiedAt > 60_000)
          throw new ConflictException('desktop_nas_producer_expired');
        await assertCurrent();
      },
    });
  }
}
