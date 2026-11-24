import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseBoundClipResult } from 'src/utils/clip-embedding.js';
import { parseBoundDescriptionResult } from 'src/utils/description-result.js';
import { type DesktopModelCatalogue, parseDesktopModelCatalogue } from 'src/utils/desktop-model-catalogue.js';
import { parseBoundFaceResult } from 'src/utils/face-result.js';
import { parseBoundOcrResult } from 'src/utils/ocr-result.js';

let catalogue: DesktopModelCatalogue | undefined;

/**
 * Whether a desktop's result has the shape its task's model returns, checked with the parsers the server
 * later decodes it with. Throws `desktop_result_invalid`, so a malformed result is refused when it is
 * submitted instead of being acknowledged and failing the job at decode.
 */
export const assertDesktopResult = (task: { modelKey: string }, result: unknown): void => {
  try {
    if (task.modelKey.startsWith('face:')) parseBoundFaceResult(result);
    else if (task.modelKey.startsWith('ocr:')) parseBoundOcrResult(result);
    else if (task.modelKey.startsWith('description:')) parseBoundDescriptionResult(result);
    else {
      catalogue ??= parseDesktopModelCatalogue(
        JSON.parse(readFileSync(join(import.meta.dirname, '../../resources/desktop/model-catalogue.json'), 'utf8')),
      );
      const profile = catalogue.profiles.find((item) => item.modelKey === task.modelKey);
      if (!profile) throw new Error('unknown model');
      parseBoundClipResult(result, profile);
    }
  } catch (error) {
    throw new Error('desktop_result_invalid', { cause: error });
  }
};
