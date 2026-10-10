import { assetCacheManager } from '$lib/managers/AssetCacheManager.svelte';
import { CancellableTask } from '$lib/utils/cancellable-task';

export type OcrBoundingBox = {
  id: string;
  assetId: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  x3: number;
  y3: number;
  x4: number;
  y4: number;
  boxScore: number;
  textScore: number;
  text: string;
};

/** The four corners of a region, normalized to the photo as it is shown. */
export type OcrRegion = Pick<OcrBoundingBox, 'x1' | 'y1' | 'x2' | 'y2' | 'x3' | 'y3' | 'x4' | 'y4'>;

/**
 * FL-63: what the owner decided about the photo's text, for the overlay. Keyed by recognized line
 * id: a string is the owner's correction, `null` a line they dismissed. Tied to one asset, so a
 * decision about one photo can never be drawn over another.
 */
export type OcrDocumentText = { assetId: string; overrides: Map<string, string | null> };

class OcrManager {
  #data = $state<OcrBoundingBox[]>([]);
  showOverlay = $state(false);
  #hasOcrData = $derived(this.#data.length > 0);
  #ocrLoader = new CancellableTask();
  #cleared = false;
  #document = $state<OcrDocumentText | null>(null);
  #highlight = $state<OcrBoundingBox | null>(null);

  /** The recognized boxes with the owner's corrections applied and their dismissed lines left out. */
  #effective = $derived.by(() => {
    const document = this.#document;
    if (!document) {
      return this.#data;
    }

    return this.#data
      .filter((box) => box.assetId !== document.assetId || document.overrides.get(box.id) !== null)
      .map((box) => {
        const text = box.assetId === document.assetId ? document.overrides.get(box.id) : undefined;
        return typeof text === 'string' ? { ...box, text } : box;
      });
  });

  get data() {
    return this.#effective;
  }

  get hasOcrData() {
    return this.#hasOcrData;
  }

  /** The one region the information panel is pointing at, drawn over the photo. */
  get highlight() {
    return this.#highlight;
  }

  async getAssetOcr(id: string) {
    if (this.#cleared) {
      await this.#ocrLoader.reset();
      this.#cleared = false;
    }
    await this.#ocrLoader.execute(async () => {
      this.#data = await assetCacheManager.getAssetOcr(id);
    }, false);
  }

  clear() {
    this.#cleared = true;
    this.#data = [];
    this.showOverlay = false;
    this.#highlight = null;
  }

  toggleOcrBoundingBox() {
    this.showOverlay = !this.showOverlay;
  }

  setDocumentText(document: OcrDocumentText | null) {
    this.#document = document;
  }

  /** Point at a region of `assetId`, or stop pointing with `null`. */
  setHighlight(assetId: string | null, region: OcrRegion | null = null) {
    this.#highlight =
      assetId && region ? { ...region, id: 'document-highlight', assetId, text: '', boxScore: 1, textScore: 1 } : null;
  }
}

export const ocrManager = new OcrManager();
