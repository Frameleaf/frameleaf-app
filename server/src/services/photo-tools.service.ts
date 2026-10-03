import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { AssetDevelopMaskKind } from 'src/dtos/asset-develop.dto.js';
import {
  DEVELOP_PRESET_MAX,
  DevelopPresetCreateDto,
  DevelopPresetResponseDto,
  type DevelopPresetSettings,
  DevelopPresetUpdateDto,
  NativeDevelopPresetSchema,
} from 'src/dtos/photo-tools.dto.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { type DevelopPreset, PhotoToolsRepository } from 'src/repositories/photo-tools.repository.js';
import { asDateTimeString } from 'src/utils/date.js';
import { STILL_SLIDER_KEYS, normalizeDevelopRecipe } from 'src/utils/develop-recipe.js';

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
        settings: dto.settings ? mergePresetSettings(existing.settings, dto.settings) : undefined,
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
    ...(settings?.native && { native: NativeDevelopPresetSchema.parse(settings.native) }),
    ...(Object.fromEntries(STILL_SLIDER_KEYS.map((key) => [key, recipe[key]])) as Pick<
      DevelopPresetSettings,
      (typeof STILL_SLIDER_KEYS)[number]
    >),
    preset: recipe.preset,
    presetStrength: recipe.presetStrength,
    // FL-233: a brush stroke or a subject/sky/background bitmap belongs to one photo's content
    masks: recipe.masks
      .filter((mask) => mask.kind === AssetDevelopMaskKind.Radial || mask.kind === AssetDevelopMaskKind.Linear)
      .map(
        ({ strokes: _strokes, artifact: _artifact, detector: _detector, ...mask }) => mask,
      ) as DevelopPresetSettings['masks'],
  };
  return picked;
}

/**
 * FL-303: an update's settings over the stored ones. Only what the request sends changes; every
 * other stored setting is kept as it was, including Brilliance from a client without that control
 * and any setting this server does not know yet. Known settings are normalized as on create.
 */
export function mergePresetSettings(
  stored: Record<string, unknown> | null | undefined,
  patch: Partial<DevelopPresetSettings>,
): Record<string, unknown> {
  const base = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
  const sent = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
  const known = normalizePresetSettings({ ...base, ...sent } as Partial<DevelopPresetSettings>);
  return {
    ...base,
    ...known,
    // masks left out stay exactly as stored, nested properties a newer client wrote included
    ...(sent.masks === undefined && Array.isArray(base.masks) && { masks: base.masks }),
  };
}
