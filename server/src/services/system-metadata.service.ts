import { BadRequestException, Injectable } from '@nestjs/common';
import { constants } from 'node:fs';
import { StorageCore } from 'src/cores/storage.core.js';
import {
  FrameleafSetupLibraryResponseDto,
  FrameleafSetupResponseDto,
  FrameleafSetupStorageResponseDto,
  FrameleafSetupUpdateDto,
  frameleafSetupProgressSchema,
} from 'src/dtos/frameleaf-setup.dto.js';
import {
  AdminOnboardingResponseDto,
  AdminOnboardingUpdateDto,
  ReverseGeocodingStateResponseDto,
  VersionCheckStateResponseDto,
} from 'src/dtos/system-metadata.dto.js';
import { StorageFolder, SystemMetadataKey } from 'src/enum.js';
import { BaseService } from 'src/services/base.service.js';
import { FrameleafSetupState } from 'src/types.js';

@Injectable()
export class SystemMetadataService extends BaseService {
  /** FL-176: "onboarded" now means Frameleaf setup is complete. */
  async getAdminOnboarding(): Promise<AdminOnboardingResponseDto> {
    const setup = await this.readSetup();
    return { isOnboarded: setup.completed };
  }

  /** Kept for API clients: marks Frameleaf setup complete (or reopens it) without the setup checks. */
  async updateAdminOnboarding(dto: AdminOnboardingUpdateDto): Promise<void> {
    await this.systemMetadataRepository.set(SystemMetadataKey.AdminOnboarding, {
      isOnboarded: dto.isOnboarded,
    });
    const setup = await this.readSetup();
    await this.writeSetup({
      ...setup,
      completed: dto.isOnboarded,
      completedAt: dto.isOnboarded ? (setup.completedAt ?? new Date().toISOString()) : null,
    });
  }

  async getFrameleafSetup(): Promise<FrameleafSetupResponseDto> {
    return this.toSetupDto(await this.readSetup());
  }

  async updateFrameleafSetup(dto: FrameleafSetupUpdateDto): Promise<FrameleafSetupResponseDto> {
    const setup = await this.readSetup();
    const next: FrameleafSetupState = {
      ...setup,
      // The flow is fixed by the first save; an existing library never turns into a new server.
      flow: setup.flow ?? dto.flow ?? 'existing',
      progress: dto.progress,
    };
    await this.writeSetup(next);
    return this.toSetupDto(next);
  }

  /** Finishes setup once an administrator exists and the library location is writable. */
  async finishFrameleafSetup(): Promise<FrameleafSetupResponseDto> {
    if (!(await this.userRepository.hasAdmin())) {
      throw new BadRequestException('Create the admin account before finishing setup');
    }
    const storage = await this.getFrameleafSetupStorage();
    if (!storage.writable) {
      throw new BadRequestException(`Frameleaf can't write to ${storage.path}`);
    }
    const setup = await this.readSetup();
    const next: FrameleafSetupState = {
      ...setup,
      flow: setup.flow ?? 'existing',
      completed: true,
      completedAt: new Date().toISOString(),
    };
    await this.writeSetup(next);
    await this.systemMetadataRepository.set(SystemMetadataKey.AdminOnboarding, { isOnboarded: true });
    return this.toSetupDto(next);
  }

  /** The "Your library is safe" numbers: every account's items, people, albums and originals. */
  async getFrameleafSetupLibrary(): Promise<FrameleafSetupLibraryResponseDto> {
    const users = await this.userRepository.getUserStats();
    let items = 0;
    let bytes = 0;
    let people = 0;
    let albums = 0;
    for (const user of users) {
      items += Number(user.photos) + Number(user.videos);
      bytes += Number(user.usage);
      const [peopleCount, userAlbums] = await Promise.all([
        this.personRepository.getNumberOfPeople(user.userId),
        this.albumRepository.getAll(user.userId, { isOwned: true }),
      ]);
      people += Number(peopleCount.total);
      albums += userAlbums.length;
    }
    return { items, people, albums, bytes, users: users.length };
  }

  /** The live check of where the library is stored: writable, and how much space is free. */
  async getFrameleafSetupStorage(): Promise<FrameleafSetupStorageResponseDto> {
    const path = StorageCore.getBaseFolder(StorageFolder.Library);
    const base = StorageCore.getMediaLocation();
    const writable =
      (await this.storageRepository.checkFileExists(path, constants.W_OK)) ||
      (await this.storageRepository.checkFileExists(base, constants.W_OK));
    let freeBytes = 0;
    let totalBytes = 0;
    try {
      const usage = await this.storageRepository.checkDiskUsage(base);
      freeBytes = usage.available;
      totalBytes = usage.total;
    } catch {
      // A location that can't be measured reports no free space; `writable` already says why.
    }
    return { path: base, writable, freeBytes, totalBytes };
  }

  private async readSetup(): Promise<FrameleafSetupState> {
    const value = await this.systemMetadataRepository.get(SystemMetadataKey.FrameleafSetup);
    return {
      completed: value?.completed === true,
      completedAt: value?.completedAt ?? null,
      flow: value?.flow === 'new' || value?.flow === 'existing' ? value.flow : null,
      progress: value?.progress ?? null,
      updatedAt: value?.updatedAt ?? null,
    };
  }

  private async writeSetup(state: FrameleafSetupState) {
    await this.systemMetadataRepository.set(SystemMetadataKey.FrameleafSetup, {
      ...state,
      updatedAt: new Date().toISOString(),
    });
  }

  private toSetupDto(setup: FrameleafSetupState): FrameleafSetupResponseDto {
    // A stored payload that no longer validates is dropped rather than resumed.
    const progress = frameleafSetupProgressSchema.safeParse(setup.progress);
    return {
      completed: setup.completed,
      completedAt: setup.completedAt,
      // No saved flow and the endpoint reached (an administrator exists): an existing library.
      flow: setup.flow ?? 'existing',
      progress: progress.success ? progress.data : null,
    };
  }

  async getReverseGeocodingState(): Promise<ReverseGeocodingStateResponseDto> {
    const value = await this.systemMetadataRepository.get(SystemMetadataKey.ReverseGeocodingState);
    return { lastUpdate: null, lastImportFileName: null, ...value };
  }

  async getVersionCheckState(): Promise<VersionCheckStateResponseDto> {
    const value = await this.systemMetadataRepository.get(SystemMetadataKey.VersionCheckState);
    return { checkedAt: null, releaseVersion: null, ...value };
  }
}
