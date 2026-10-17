import { assetCacheManager } from '$lib/managers/AssetCacheManager.svelte';

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
  #loading: Promise<void> | undefined;
  #generation = 0;
  #document = $state<OcrDocumentText | null>(null);
  #highlight = $state<OcrBoundingBox | null>(null);

  /** The recognized boxes with the owner's corrections applied and their dismissed lines left out. */
  #effective = $derived.by(() => {
    const document = this.#document;
    const data = this.#data;
    if (!document) {
      return data;
    }

    const effective: OcrBoundingBox[] = [];
    const length = data.length;
    for (let index = 0; index < length; index++) {
      // Match the prior array filtering when a caller leaves a sparse array.
      if (!Reflect.has(data, index)) {
        continue;
      }
      const box = data[index];
      const text = box.assetId === document.assetId ? document.overrides.get(box.id) : undefined;
      if (text !== null) {
        effective.push(typeof text === 'string' ? { ...box, text } : box);
      }
    }
    return effective;
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

  /** Refresh after invalidating the shared cache when a new recognition replaces the boxes. */
  async getAssetOcr(id: string, refresh = false) {
    if (refresh) {
      this.#generation++;
      this.#loading = undefined;
      this.#data = [];
    }
    if (this.#loading) {
      await this.#loading;
      return;
    }
    const generation = this.#generation;
    let resolve!: () => void;
    const pending = new Promise<void>((done) => {
      resolve = done;
    });
    this.#loading = pending;
    try {
      const boxes = await assetCacheManager.getAssetOcr(id);
      if (generation === this.#generation && this.#loading === pending) {
        this.#data = boxes;
      }
    } catch {
      if (generation === this.#generation && this.#loading === pending) {
        this.#loading = undefined;
      }
    } finally {
      resolve();
    }
  }

  clear() {
    this.#generation++;
    this.#loading = undefined;
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
