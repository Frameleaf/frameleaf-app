import { Injectable } from '@nestjs/common';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OnEvent } from 'src/decorators.js';
import { FrameleafWorker, MediaOperationDestination, RenderWorkerAuditEvent, RenderWorkerStatus } from 'src/enum.js';
import { BaseService } from 'src/services/base.service.js';
import {
  BUNDLED_RENDER_WORKER_APPROVAL,
  BUNDLED_RENDER_WORKER_KINDS,
  BUNDLED_RENDER_WORKER_NAME,
  BUNDLED_RENDER_WORKER_TRUST_FILE,
  isBundledRenderWorker,
} from 'src/utils/bundled-render-worker.js';
import { STUDIO_ENGINE_REVISION } from 'src/utils/studio-commands.generated.js';

export type BundledEnrolmentOutcome = 'disabled' | 'revoked' | 'enrolled' | 'unavailable';

/**
 * FL-408: enrol the Studio render worker that ships in the bundled machine-learning container.
 *
 * At every start the server makes sure one active bundled worker exists, gives it a fresh
 * enrolment secret, and writes `{ workerId, enrolmentSecret }` to a private volume that only this
 * server (read-write) and the machine-learning container (read-only) mount. The secret never
 * travels from the server over the network; the worker presents it once, at admission, from the
 * container network (`isInternalWorkerOrigin`). An administrator who revokes the bundled worker
 * keeps it revoked: it is not silently re-enrolled.
 */
@Injectable()
export class BundledRenderWorkerService extends BaseService {
  @OnEvent({ name: 'AppBootstrap', workers: [FrameleafWorker.Microservices] })
  async onBootstrap(): Promise<void> {
    try {
      await this.ensureEnrolment();
    } catch (error) {
      this.logger.warn(`Bundled Studio worker could not be enrolled: ${error}`);
    }
  }

  async ensureEnrolment(): Promise<BundledEnrolmentOutcome> {
    const { studioWorker } = this.configRepository.getEnv();
    if (!studioWorker.enabled) {
      this.logger.log('Bundled Studio worker disabled (FRAMELEAF_STUDIO_WORKER=false)');
      return 'disabled';
    }

    const bundled = (await this.renderWorkerRepository.listWorkers()).filter((worker) => isBundledRenderWorker(worker));
    let worker = bundled.find((candidate) => candidate.status === RenderWorkerStatus.Active);
    if (!worker && bundled.length > 0) {
      this.logger.log('Bundled Studio worker was revoked by an administrator; not re-enrolling it');
      return 'revoked';
    }

    const enrolmentSecret = this.cryptoRepository.randomBytesAsText(32);
    const digest = this.cryptoRepository.hashSha256(enrolmentSecret);
    if (worker) {
      if (!(await this.renderWorkerRepository.setEnrolmentSecret(worker.id, digest))) {
        return 'revoked';
      }
      if (worker.engineDigest !== STUDIO_ENGINE_REVISION) {
        // Pinned to the engine this server's Studio stores projects for; an upgrade moves it along.
        await this.renderWorkerRepository.updateWorker(worker.id, { engineDigest: STUDIO_ENGINE_REVISION });
      }
    } else {
      worker = await this.renderWorkerRepository.createWorker({
        name: BUNDLED_RENDER_WORKER_NAME,
        destination: MediaOperationDestination.Local,
        kinds: [...BUNDLED_RENDER_WORKER_KINDS],
        enrolmentSecret: digest,
        // Artifact transport and claim admission require the session to match a pinned engine.
        engineDigest: STUDIO_ENGINE_REVISION,
        maxConcurrentOperations: 1,
        maxWallClockMs: null,
        maxOutputBytes: null,
        gpuMemoryBytes: null,
        gpuWorkingBudgetApproval: BUNDLED_RENDER_WORKER_APPROVAL,
        createdBy: null,
      });
      await this.renderWorkerRepository.recordAudit({
        workerId: worker.id,
        event: RenderWorkerAuditEvent.Enrolled,
        actorId: null,
        detail: { name: worker.name, destination: worker.destination, kinds: worker.kinds, bundled: true },
      });
      this.logger.log(`Bundled Studio worker ${worker.id} enrolled`);
    }

    try {
      await this.writeTrust(studioWorker.trustDir, { version: 1, workerId: worker.id, enrolmentSecret });
    } catch (error) {
      this.logger.warn(
        `Bundled Studio worker enrolment could not be written to ${studioWorker.trustDir} (${error}); ` +
          'mount the studio-worker volume on the server and the machine-learning container',
      );
      return 'unavailable';
    }
    return 'enrolled';
  }

  /** Write atomically, owner-only: the machine-learning container reads it as the same user. */
  private async writeTrust(directory: string, trust: { version: 1; workerId: string; enrolmentSecret: string }) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const target = join(directory, BUNDLED_RENDER_WORKER_TRUST_FILE);
    const partial = `${target}.${process.pid}.partial`;
    try {
      await writeFile(partial, `${JSON.stringify(trust)}\n`, { mode: 0o600, flag: 'w' });
      await rename(partial, target);
    } finally {
      await rm(partial, { force: true });
    }
  }
}
