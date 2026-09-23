import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import {
  DEVELOP_PRESET_MAX,
  DevelopPresetCreateDto,
  DevelopPresetResponseDto,
  type DevelopPresetSettings,
  DevelopPresetUpdateDto,
} from 'src/dtos/photo-tools.dto.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { type DevelopPreset, PhotoToolsRepository } from 'src/repositories/photo-tools.repository.js';
import { asDateTimeString } from 'src/utils/date.js';
import { DEVELOP_SLIDER_KEYS, normalizeDevelopRecipe } from 'src/utils/develop-recipe.js';

/**
 * Reusable develop presets (FL-64). A preset is a named set of develop settings — sliders, look,
 * strength and selective masks, never geometry — that its owner applies to any photo in the
 * editor. Presets are private to their owner: another account's preset answers 404 exactly like
 * one that does not exist.
 */
@Injectable()
export class PhotoToolsService {
  constructor(
    private logger: LoggingRepository,
    private photoToolsRepository: PhotoToolsRepository,
  ) {
    this.logger.setContext(PhotoToolsService.name);
  }

  async listPresets(auth: AuthDto): Promise<DevelopPresetResponseDto[]> {
    const presets = await this.photoToolsRepository.listPresets(auth.user.id);
    return presets.map((preset) => this.toDto(preset));
  }

  async createPreset(auth: AuthDto, dto: DevelopPresetCreateDto): Promise<DevelopPresetResponseDto> {
    if ((await this.photoToolsRepository.countPresets(auth.user.id)) >= DEVELOP_PRESET_MAX) {
      throw new BadRequestException(`You can keep up to ${DEVELOP_PRESET_MAX} presets; delete one first`);
    }
    await this.requireFreeName(auth.user.id, dto.name);
    try {
      const preset = await this.photoToolsRepository.createPreset({
        ownerId: auth.user.id,
        name: dto.name,
        settings: normalizePresetSettings(dto.settings),
      });
      return this.toDto(preset);
    } catch (error) {
      throw this.conflictOr(error);
    }
  }

  async updatePreset(auth: AuthDto, id: string, dto: DevelopPresetUpdateDto): Promise<DevelopPresetResponseDto> {
    const existing = await this.photoToolsRepository.getPreset(auth.user.id, id);
    if (!existing) {
      throw new NotFoundException('Preset not found');
    }
    if (dto.name !== undefined && dto.name !== existing.name) {
      await this.requireFreeName(auth.user.id, dto.name);
    }
    try {
      const updated = await this.photoToolsRepository.updatePreset(auth.user.id, id, {
        name: dto.name,
        settings: dto.settings ? normalizePresetSettings(dto.settings) : undefined,
      });
      if (!updated) {
        throw new NotFoundException('Preset not found');
      }
      return this.toDto(updated);
    } catch (error) {
      throw this.conflictOr(error);
    }
  }

  async deletePreset(auth: AuthDto, id: string): Promise<void> {
    if (!(await this.photoToolsRepository.deletePreset(auth.user.id, id))) {
      throw new NotFoundException('Preset not found');
    }
  }

  private async requireFreeName(ownerId: string, name: string) {
    if (await this.photoToolsRepository.getPresetByName(ownerId, name)) {
      throw new ConflictException('A preset with this name already exists');
    }
  }

  /** Two requests racing for one name meet the unique key; the loser gets the same answer. */
  private conflictOr(error: unknown) {
    const code = (error as { code?: string } | null)?.code;
    return code === '23505' ? new ConflictException('A preset with this name already exists') : error;
  }

  private toDto(preset: DevelopPreset): DevelopPresetResponseDto {
    return {
      id: preset.id,
      name: preset.name,
      settings: normalizePresetSettings(preset.settings as Partial<DevelopPresetSettings>),
      createdAt: asDateTimeString(preset.createdAt),
      updatedAt: asDateTimeString(preset.updatedAt),
    };
  }
}

/** The preset keys of a normalized recipe: clamped, defaults filled, geometry never included. */
export function normalizePresetSettings(settings: Partial<DevelopPresetSettings> | null | undefined) {
  const recipe = normalizeDevelopRecipe(settings ?? {});
  const picked: DevelopPresetSettings = {
    ...(Object.fromEntries(DEVELOP_SLIDER_KEYS.map((key) => [key, recipe[key]])) as Pick<
      DevelopPresetSettings,
      (typeof DEVELOP_SLIDER_KEYS)[number]
    >),
    preset: recipe.preset,
    presetStrength: recipe.presetStrength,
    masks: recipe.masks,
  };
  return picked;
}
