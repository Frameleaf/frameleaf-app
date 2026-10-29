import { BadRequestException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import {
  StudioCaptionTranslationCreateDto,
  StudioCaptionTranslationDto,
} from 'src/dtos/studio-caption-translation.dto.js';
import { MlProcessingSource, MlWorkload } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import {
  MachineLearningRepository,
  TranslationUnavailableError,
} from 'src/repositories/machine-learning.repository.js';
import { MlDestinationRepository } from 'src/repositories/ml-destination.repository.js';
import { StudioProjectService } from 'src/services/studio-project.service.js';
import { selectMlDestination } from 'src/utils/ml-destination.js';

/** One request translates a whole project's captions; a CPU worker needs about a minute for long ones. */
const TRANSLATION_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Studio captions in other languages (FL-641, owner decision 2026-10-29).
 *
 * The editor sends the caption lines of one project, as text, with the language they are in and the
 * language to translate into. The lines go to the first place in the processing order that can
 * translate ("Where work runs": this server, then the person's computers), and the translations come
 * back in the same order, so each keeps its line's timing. A place that cannot translate (an older
 * worker, no model) is passed over for the next. Frameleaf Cloud has no translation workload yet, so
 * it is never sent the text (follow-up on FL-641). Nothing is stored: the editor keeps the translated
 * lines in the project as their own caption track.
 */
@Injectable()
export class StudioCaptionTranslationService {
  constructor(
    private logger: LoggingRepository,
    private studio: StudioProjectService,
    private machineLearning: MachineLearningRepository,
    private mlDestinations: MlDestinationRepository,
  ) {
    this.logger.setContext(StudioCaptionTranslationService.name);
  }

  async translate(
    auth: AuthDto,
    projectId: string,
    dto: StudioCaptionTranslationCreateDto,
  ): Promise<StudioCaptionTranslationDto> {
    if (auth.sharedLink) {
      throw new NotFoundException('Studio project not found');
    }
    await this.studio.requireOwnedProject(auth, projectId, 'Only the project owner can translate its captions');
    const signal = AbortSignal.timeout(TRANSLATION_TIMEOUT_MS);
    const candidates = await this.mlDestinations.resolveRoute(MlWorkload.StudioAi);
    let cloudOnly = false;
    for (const candidate of candidates) {
      // Studio AI has no desktop assistance pool; computers at home serve it as their own destinations.
      if (!candidate.available || candidate.desktopPool) {
        continue;
      }
      if (candidate.source === MlProcessingSource.Cloud) {
        cloudOnly = true;
        continue;
      }
      let selection;
      try {
        selection = await selectMlDestination(
          { mlDestinationRepository: this.mlDestinations, machineLearningRepository: this.machineLearning },
          {
            workload: MlWorkload.StudioAi,
            destinationId: candidate.destinationId,
            jobName: 'studio-caption-translation',
            desktopPool: 'skip',
          },
        );
      } catch (error) {
        this.logger.warn(`Caption translation: ${candidate.destinationId} cannot take it now: ${error}`);
        continue;
      }
      try {
        const result = await this.machineLearning.translateCaptions(
          selection,
          { source: dto.source, target: dto.target, lines: dto.lines },
          signal,
        );
        return {
          source: dto.source,
          target: dto.target,
          lines: result.translations,
          model: result.model,
          destinationId: selection.destinationId,
        };
      } catch (error) {
        if (error instanceof TranslationUnavailableError) {
          this.logger.warn(`Caption translation: ${candidate.destinationId} cannot translate: ${error.message}`);
          continue;
        }
        if (error instanceof BadRequestException || error instanceof ServiceUnavailableException) {
          throw error;
        }
        this.logger.warn(`Caption translation on ${candidate.destinationId} failed: ${error}`);
        throw new ServiceUnavailableException('The captions could not be translated. Try again.');
      }
    }
    throw new ServiceUnavailableException(
      cloudOnly
        ? 'Captions are translated on this server or a computer at home, and none is available now.'
        : 'No computer that can translate captions is available now.',
    );
  }
}
