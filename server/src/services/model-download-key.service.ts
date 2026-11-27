import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { ModelDownloadKeyState } from 'src/types.js';
import { OnEvent } from 'src/decorators.js';
import { ModelDownloadKeyResponseDto, ModelDownloadKeyUpdateDto } from 'src/dtos/model-download-key.dto.js';
import { SystemMetadataKey } from 'src/enum.js';
import { BaseService } from 'src/services/base.service.js';
import { identityDirectory } from 'src/utils/frameleaf-cloud-gateway.js';
import {
  MODEL_DOWNLOAD_KEY_RECHECK_MS,
  MODEL_DOWNLOAD_KEY_SEAL_PURPOSE,
  type ModelDownloadKeyCheck,
  checkModelDownloadKey,
  openModelDownloadKey,
  sealModelDownloadKey,
} from 'src/utils/model-download-key.js';

/** How often each server process reads the saved key again, so a change reaches every worker soon. */
const RELOAD_MS = 10_000;

/**
 * Settings → Computers → Advanced → Connections → Faster model downloads (FL-1825). Keeps the optional
 * Hugging Face key sealed, checks it with Hugging Face when it is saved and again when the page is opened
 * an hour or more later, and hands it to this server's own ML service with each request.
 */
@Injectable()
export class ModelDownloadKeyService extends BaseService {
  private timer?: NodeJS.Timeout;
  /** Bumped by Save and Remove, so a background read that started earlier never undoes them. */
  private generation = 0;
  private reloading = false;
  /** Replaced in tests; the one outbound call this feature makes. */
  check: (key: string) => Promise<ModelDownloadKeyCheck> = (key) => checkModelDownloadKey(key);

  @OnEvent({ name: 'AppBootstrap' })
  async onBootstrap() {
    await this.reload();
    this.timer = setInterval(() => void this.reload(), RELOAD_MS);
    this.timer.unref();
  }

  @OnEvent({ name: 'AppShutdown' })
  onShutdown() {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  async getStatus(): Promise<ModelDownloadKeyResponseDto> {
    return toDto(await this.refresh());
  }

  async save({ key }: ModelDownloadKeyUpdateDto): Promise<ModelDownloadKeyResponseDto> {
    const answer = await this.check(key);
    if (answer === 'refused') {
      throw new BadRequestException('Hugging Face did not accept this key');
    }
    if (answer === 'unreachable') {
      throw new ServiceUnavailableException('Could not reach Hugging Face to check the key; try again');
    }
    const now = new Date().toISOString();
    const next: ModelDownloadKeyState = {
      sealed: sealModelDownloadKey(await this.keyedHash(), key),
      savedAt: now,
      state: 'accepted',
      checkedAt: now,
    };
    await this.systemMetadataRepository.set(SystemMetadataKey.ModelDownloadKey, next);
    this.generation++;
    this.machineLearningRepository.setModelDownloadKey(key);
    this.logger.log('A Hugging Face key for model downloads was saved');
    return toDto(next);
  }

  async remove(): Promise<void> {
    await this.systemMetadataRepository.delete(SystemMetadataKey.ModelDownloadKey);
    this.generation++;
    this.machineLearningRepository.setModelDownloadKey(null);
  }

  /**
   * Each process reads the saved key again every few seconds. A key Hugging Face refused is not passed on
   * (Hugging Face answers 401 to a refused key even for public models, so it would stop every download),
   * and a key last checked an hour or more ago is checked again, so a revoked key stops being used
   * without anyone opening Settings.
   */
  private async reload() {
    // One read at a time per process: a slow Hugging Face check never overlaps the next tick's read.
    if (this.reloading) {
      return;
    }
    this.reloading = true;
    try {
      const generation = this.generation;
      const before = await this.stored();
      await this.refresh();
      const hash = await this.keyedHash();
      // The key is decided from the record as it is now, after any check: a Save, Remove or "refused"
      // written here or in another server process while this read ran wins, and nothing is applied when
      // the key itself was removed or replaced meanwhile. No await separates this read from the hand-over.
      const current = await this.stored();
      if (generation !== this.generation || !sameRecord(current, before)) {
        return;
      }
      this.machineLearningRepository.setModelDownloadKey(
        current?.state === 'accepted' ? openModelDownloadKey(hash, current.sealed) : null,
      );
    } catch (error) {
      this.logger.warn(`Could not read the model download key: ${error}`);
    } finally {
      this.reloading = false;
    }
  }

  /** The saved key's state, checked with Hugging Face again when the last answer is an hour old. */
  private async refresh(): Promise<ModelDownloadKeyState | null> {
    const stored = await this.stored();
    if (!stored || Date.now() - Date.parse(stored.checkedAt) < MODEL_DOWNLOAD_KEY_RECHECK_MS) {
      return stored;
    }
    const key = openModelDownloadKey(await this.keyedHash(), stored.sealed);
    if (!key) {
      // Sealed under another key file (a restored database, or a volume not mounted yet): kept as it is,
      // never used, and shown as no key until it is replaced or removed.
      return null;
    }
    const answer = await this.check(key);
    if (answer === 'unreachable') {
      return stored;
    }
    const next: ModelDownloadKeyState = {
      ...stored,
      state: answer === 'accepted' ? 'accepted' : 'refused',
      checkedAt: new Date().toISOString(),
    };
    // Only while the stored key is still the one checked: a Remove or Replace during the check wins.
    if (!(await this.systemMetadataRepository.setModelDownloadKeyCheck(stored, next))) {
      return this.stored();
    }
    return next;
  }

  private async stored(): Promise<ModelDownloadKeyState | null> {
    return (await this.systemMetadataRepository.get(SystemMetadataKey.ModelDownloadKey)) ?? null;
  }

  private keyedHash() {
    return this.cryptoRepository.serverKeyedHash(
      identityDirectory(this.configRepository),
      MODEL_DOWNLOAD_KEY_SEAL_PURPOSE,
      'v1',
    );
  }
}

const toDto = (stored: ModelDownloadKeyState | null): ModelDownloadKeyResponseDto => ({
  status: stored ? (stored.state === 'accepted' ? 'saved' : 'refused') : 'none',
  savedAt: stored?.savedAt ?? null,
  checkedAt: stored?.checkedAt ?? null,
});

/** The same saved key: neither removed nor replaced in between (the check fields may differ). */
const sameRecord = (a: ModelDownloadKeyState | null, b: ModelDownloadKeyState | null) =>
  a?.sealed === b?.sealed && a?.savedAt === b?.savedAt;
