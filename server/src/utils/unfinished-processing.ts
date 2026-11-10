import type { SystemConfig } from 'src/dtos/config.dto.js';
import { JobName } from 'src/enum.js';
import { isFacialRecognitionEnabled, isOcrEnabled, isSmartSearchEnabled } from 'src/utils/misc.js';
import { videoProcessingPolicy } from 'src/utils/video-processing-policy.js';

export const unfinishedProcessing = ({ machineLearning, image, ffmpeg }: SystemConfig) => ({
  selections: {
    metadata: [JobName.AssetExtractMetadata, true],
    thumbnails: [JobName.AssetGenerateThumbnails, true],
    video: [JobName.AssetEncodeVideo, true],
    search: [JobName.SmartSearch, isSmartSearchEnabled(machineLearning)],
    faces: [JobName.AssetDetectFaces, isFacialRecognitionEnabled(machineLearning)],
    text: [JobName.Ocr, isOcrEnabled(machineLearning)],
  } as const,
  options: { fullsizeEnabled: image.fullsize.enabled, videoPolicy: videoProcessingPolicy(ffmpeg) },
});
