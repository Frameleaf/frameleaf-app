import { BadRequestException, Injectable } from '@nestjs/common';
import {
  LegacyPluginTemplateResponseDto,
  PluginMethodResponseDto,
  PluginMethodSearchDto,
  PluginResponseDto,
  PluginSearchDto,
  mapMethod,
  mapPlugin,
  mapTemplate,
} from 'src/dtos/plugin.dto.js';
import { LegacyWorkflowTriggerSchema } from 'src/enum.js';
import { BaseService } from 'src/services/base.service.js';
import { isMethodCompatible } from 'src/utils/workflow.js';

@Injectable()
export class PluginService extends BaseService {
  async search(dto: PluginSearchDto): Promise<PluginResponseDto[]> {
    const plugins = await this.pluginRepository.search(dto);
    return plugins.map((plugin) => mapPlugin(plugin));
  }

  async get(id: string): Promise<PluginResponseDto> {
    const plugin = await this.pluginRepository.get(id);
    if (!plugin) {
      throw new BadRequestException('Plugin not found');
    }
    return mapPlugin(plugin);
  }

  async searchMethods(dto: PluginMethodSearchDto): Promise<PluginMethodResponseDto[]> {
    const methods = await this.pluginRepository.searchMethods(dto);
    return methods
      .filter((method) => !dto.trigger || isMethodCompatible(method, dto.trigger))
      .map((method) => mapMethod(method));
  }

  async searchTemplates(): Promise<LegacyPluginTemplateResponseDto[]> {
    // templates of enabled plugins only, like the methods they use
    const plugins = await this.pluginRepository.search({ enabled: true });
    return plugins
      .flatMap((plugin) => plugin.templates.map((template) => mapTemplate(plugin, template)))
      .filter(
        (template): template is LegacyPluginTemplateResponseDto =>
          LegacyWorkflowTriggerSchema.safeParse(template.trigger).success,
      );
  }
}
