import { Injectable } from '@nestjs/common';

import type { JobOf } from 'src/types.js';
import { OnJob } from 'src/decorators.js';
import { AssetVisibility, JobName, JobStatus, MlWorkload, QueueName } from 'src/enum.js';
import { OCR } from 'src/repositories/machine-learning.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { getDimensions } from 'src/utils/asset.util.js';
import { tokenizeForSearch } from 'src/utils/database.js';
import { DocumentRegion, cropBoxOf, isRegionInsideCrop } from 'src/utils/documents.js';
import { batched, isOcrEnabled } from 'src/utils/misc.js';

@Injectable()
export class OcrService extends BaseService {
  @OnJob({ name: JobName.OcrQueueAll, queue: QueueName.Ocr })
  async handleQueueOcr({ force }: JobOf<JobName.OcrQueueAll>): Promise<JobStatus> {
    const { machineLearning } = await this.getConfig({ withCache: false });
    if (!isOcrEnabled(machineLearning)) {
      return JobStatus.Skipped;
    }

    if (force) {
      await this.ocrRepository.deleteAll();
    }

    for await (const assets of batched(this.assetJobRepository.streamForOcrJob(force))) {
      await this.jobRepository.queueAll(assets.map((asset) => ({ name: JobName.Ocr, data: { id: asset.id } })));
    }

    return JobStatus.Success;
  }

  @OnJob({ name: JobName.Ocr, queue: QueueName.Ocr })
  async handleOcr({ id }: JobOf<JobName.Ocr>): Promise<JobStatus> {
    const { machineLearning } = await this.getConfig({ withCache: true });
    if (!isOcrEnabled(machineLearning)) {
      return JobStatus.Skipped;
    }

    const asset = await this.assetJobRepository.getForOcr(id);
    if (!asset || !asset.previewFile) {
      return JobStatus.Failed;
    }

    if (asset.visibility === AssetVisibility.Hidden) {
      return JobStatus.Skipped;
    }

    const selection = await this.selectRoutedMlDestination({
      workload: MlWorkload.Ocr,
      jobId: id,
      jobName: JobName.Ocr,
    });
    const ocrResults = await this.machineLearningRepository.ocr(selection, asset.previewFile, machineLearning.ocr);
    const { ocrDataList, searchText } = this.parseOcrResults(id, ocrResults, await this.getCropVisibility(id));
    await this.ocrRepository.upsert(id, ocrDataList, searchText);

    await this.assetRepository.upsertJobStatus({ assetId: id, ocrAt: new Date() });

    this.logger.debug(`Processed ${ocrResults.text.length} OCR result(s) for ${id}`);
    return JobStatus.Success;
  }

  /**
   * FL-63: the preview is read uncropped, so a cropped photo's lines are checked against the crop as
   * they are stored, the way an edit checks them (`checkOcrVisibility`). Reading a cropped photo again
   * must not make the text the crop removed visible or searchable again.
   */
  private async getCropVisibility(id: string) {
    const asset = await this.assetRepository.getForOcr(id);
    const crop = asset ? cropBoxOf(asset.edits) : undefined;
    if (!asset || !crop) {
      return;
    }
    const dimensions = getDimensions(asset);
    return (region: DocumentRegion) => isRegionInsideCrop(region, dimensions, crop);
  }

  private parseOcrResults(
    id: string,
    { box, boxScore, text, textScore }: OCR,
    isVisible?: (region: DocumentRegion) => boolean,
  ) {
    const ocrDataList = [];
    const searchTokens = [];
    for (let i = 0; i < text.length; i++) {
      const rawText = text[i];
      const boxOffset = i * 8;
      const region = {
        x1: box[boxOffset],
        y1: box[boxOffset + 1],
        x2: box[boxOffset + 2],
        y2: box[boxOffset + 3],
        x3: box[boxOffset + 4],
        y3: box[boxOffset + 5],
        x4: box[boxOffset + 6],
        y4: box[boxOffset + 7],
      };
      const visible = isVisible ? isVisible(region) : true;
      ocrDataList.push({
        assetId: id,
        ...region,
        boxScore: boxScore[i],
        textScore: textScore[i],
        text: rawText,
        ...(isVisible && { isVisible: visible }),
      });
      if (visible) {
        searchTokens.push(...tokenizeForSearch(rawText));
      }
    }

    return { ocrDataList, searchText: searchTokens.join(' ') };
  }
}
