import { Injectable } from '@nestjs/common';
import { BaseService } from 'src/services/base.service.js';
import { isSmartSearchEnabled } from 'src/utils/misc.js';

/**
 * FL-1196 "What the AI sees": everyday subjects a library is made of. Each is matched with CLIP as
 * "a photo of …"; the web names them (`frameleaf_magic_seen_<id>`).
 */
export const SEEN_LABELS = {
  people: 'people',
  children: 'children',
  dogs: 'a dog',
  cats: 'a cat',
  birds: 'birds',
  mountains: 'mountains',
  lakes: 'a lake',
  beaches: 'a beach',
  ocean: 'the ocean',
  forests: 'a forest',
  snow: 'snow',
  flowers: 'flowers',
  gardens: 'a garden',
  sunsets: 'a sunset',
  sky: 'the sky and clouds',
  cities: 'a city street',
  buildings: 'buildings',
  homes: 'the inside of a home',
  food: 'food',
  drinks: 'drinks',
  cars: 'a car',
  roads: 'a road trip',
  boats: 'a boat',
  planes: 'an airplane',
  parties: 'a party',
  weddings: 'a wedding',
  concerts: 'a concert',
  sports: 'sports',
  hiking: 'hiking',
  documents: 'a document or screenshot',
  art: 'art',
  night: 'the night sky',
} as const;
export type SeenLabelId = keyof typeof SEEN_LABELS;

const cache = new Map<string, Promise<Array<{ id: string; embedding: string }>>>();

@Injectable()
export class SeenLabelsService extends BaseService {
  /**
   * The labels as embeddings of the server's current CLIP model, encoded once per model and kept in
   * memory. Undefined when visual search is off or the computer that encodes text doesn't answer, so
   * the report simply goes without the panel.
   */
  async labels(): Promise<Array<{ id: string; embedding: string }> | undefined> {
    const { machineLearning } = await this.getConfig({ withCache: true });
    if (!isSmartSearchEnabled(machineLearning)) {
      return undefined;
    }
    const modelName = machineLearning.clip.modelName;
    try {
      const key = `${modelName}\u{0}${await this.machineLearningRepository.clipCacheKey(modelName)}`;
      let labels = cache.get(key);
      if (!labels) {
        labels = this.encode(modelName);
        cache.set(key, labels);
        labels.catch(() => cache.delete(key));
      }
      return await labels;
    } catch (error) {
      this.logger.warn(`What the AI sees is unavailable: ${String(error)}`);
      return undefined;
    }
  }

  private async encode(modelName: string) {
    const selection = await this.selectClipTextDestination();
    const labels = [];
    // ponytail: one request per label, once per model; batch them if the label list grows a lot.
    for (const [id, phrase] of Object.entries(SEEN_LABELS)) {
      const embedding = await this.machineLearningRepository.encodeText(selection, `a photo of ${phrase}`, {
        modelName,
      });
      labels.push({ id, embedding });
    }
    return labels;
  }
}
