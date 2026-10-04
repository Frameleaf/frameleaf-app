import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { FileHandle, lstat, mkdtemp, open, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { OnEvent } from 'src/decorators.js';
import {
  ICloudIdentityAdoptionRepository,
  IdentityAdoptionAuthority,
  IdentityAdoptionCandidate,
  IdentityAdoptionEvidence,
  IdentityAdoptionResult,
} from 'src/repositories/icloud-identity-adoption.repository.js';
import { weeklyIdentityAdoptionActive } from 'src/repositories/icloud-weekly-adoption-authority.js';
import { identityMatchingEnabled } from 'src/services/icloud-identity.service.js';
import {
  MediaIntegrityIdentity,
  MediaIntegrityService,
  MediaIntegrityValidation,
} from 'src/services/media-integrity.service.js';
import { appleFingerprintHash } from 'src/utils/icloud-identity.js';

/** Prerequisite only: keep OFF until Apple AND mandatory weekly authority/scheduling qualify. */
export const identityAdoptionEnabled = () =>
  identityMatchingEnabled() &&
  weeklyIdentityAdoptionActive() &&
  ['true', '1', 'yes', 'on'].includes((process.env.FRAMELEAF_ICLOUD_IDENTITY_ADOPTION ?? '').trim().toLowerCase());
const fileIdentity = (value: MediaIntegrityIdentity): MediaIntegrityIdentity => ({
  dev: value.dev,
  ino: value.ino,
  size: value.size,
  mtimeMs: value.mtimeMs,
  ctimeMs: value.ctimeMs,
});
const sameFile = (a: MediaIntegrityIdentity, b: MediaIntegrityIdentity) =>
  Object.entries(a).every(([key, value]) => b[key as keyof MediaIntegrityIdentity] === value);

/** One producer and owned-file lifetime; no remote provider or public API authority. */
@Injectable()
export class ICloudIdentityAdoptionService {
  private readonly cleanups = new Set<Promise<void>>();
  constructor(
    private repository: ICloudIdentityAdoptionRepository,
    private integrity: MediaIntegrityService,
  ) {}

  @OnEvent({ name: 'AppShutdown' })
  async onShutdown() {
    await Promise.allSettled(this.cleanups);
  }

  async adopt(authority: IdentityAdoptionAuthority): Promise<IdentityAdoptionResult> {
    if (!identityAdoptionEnabled()) {
      return 'miss';
    }
    let source: FileHandle | undefined;
    let directory: string | undefined;
    let validation: MediaIntegrityValidation | undefined;
    const cleanup = async () => {
      if (validation) {
        await validation.settled;
      }
      if (directory) {
        await rm(directory, { recursive: true, force: true });
      }
    };
    try {
      return await this.repository.adopt(
        authority,
        async (candidate: IdentityAdoptionCandidate): Promise<IdentityAdoptionEvidence | 'miss' | undefined> => {
          source = await open(candidate.originalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
          const before = await source.stat();
          const named = await lstat(candidate.originalPath);
          const identity = fileIdentity(before);
          if (!before.isFile() || !named.isFile() || !sameFile(identity, named)) {
            return;
          }
          // A private sibling directory is on the same managed filesystem, never an arbitrary parent.
          directory = await mkdtemp(join(dirname(candidate.originalPath), '.icloud-identity-'));
          const copyPath = join(directory, 'validation');
          const copy = await open(copyPath, 'wx', 0o600);
          const sha1 = createHash('sha1');
          const sha256 = createHash('sha256');
          const fingerprint = appleFingerprintHash();
          let sizeInBytes = 0;
          try {
            for await (const chunk of source.createReadStream({ autoClose: false })) {
              const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
              sha1.update(bytes);
              sha256.update(bytes);
              fingerprint.update(bytes);
              sizeInBytes += bytes.length;
              // FileHandle.write can be short; writeFile completes the whole chunk at the current position.
              await copy.writeFile(bytes);
            }
            await copy.sync();
          } finally {
            await copy.close();
          }
          const evidence = {
            sha1: sha1.digest(),
            sha256: sha256.digest(),
            sizeInBytes,
            appleFingerprint: fingerprint.digest(),
          };
          const handle = source;
          const current = async () => {
            const [opened, path] = await Promise.all([handle.stat(), lstat(candidate.originalPath)]);
            return (
              identityAdoptionEnabled() &&
              opened.isFile() &&
              path.isFile() &&
              sameFile(identity, opened) &&
              sameFile(identity, path)
            );
          };
          if (sizeInBytes === 0 || sizeInBytes !== identity.size || !(await current())) {
            return;
          }
          validation = this.integrity.validateWithSettlement({
            path: copyPath,
            originalFileName: candidate.originalFileName,
            type: candidate.type,
            expected: evidence,
            deep: true,
          });
          const decoded = await validation.result;
          if (decoded.status === 'unsupported') {
            return 'miss';
          }
          if (decoded.status !== 'healthy') {
            return;
          }
          await validation.settled;
          if (!identityAdoptionEnabled() || !(await current())) {
            return;
          }
          return { ...evidence, identity, current };
        },
      );
    } catch {
      return 'retry';
    } finally {
      try {
        await source?.close();
      } finally {
        // Deadline refusal releases the transaction before awaiting noncooperative decode. Never
        // remove its input early; observe cleanup rejection and retain the exact owned copy on failure.
        const pending = cleanup()
          .catch(() => {})
          .finally(() => this.cleanups.delete(pending));
        this.cleanups.add(pending);
      }
    }
  }
}
