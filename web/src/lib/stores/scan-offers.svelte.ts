import { offerScanSplit } from '@frameleaf/sdk';

export type ScanOffer = { assetId: string; name: string; count: number };

/**
 * FL-923: the split offers of an upload batch. Only files uploaded into an album reach this, the server answers 0
 * unless that album holds scans, and they are checked one at a time so a big batch never floods the ML worker.
 */
class ScanOffers {
  offers = $state<ScanOffer[]>([]);
  #seen = new Set<string>();
  #queue: { assetId: string; name: string }[] = [];
  #running = false;
  #generation = 0;

  get current() {
    return this.offers[0];
  }

  check(assetId: string, name: string) {
    if (this.#seen.has(assetId)) {
      return;
    }
    this.#seen.add(assetId);
    this.#queue.push({ assetId, name });
    void this.#drain();
  }

  async #drain() {
    if (this.#running) {
      return;
    }
    this.#running = true;
    const generation = this.#generation;
    while (generation === this.#generation && this.#queue.length > 0) {
      const { assetId, name } = this.#queue.shift()!;
      try {
        const { printCount } = await offerScanSplit({ id: assetId });
        if (generation === this.#generation && printCount > 1) {
          this.offers.push({ assetId, name, count: printCount });
        }
      } catch {
        // an offer is optional: the photo is safely uploaded and can be split from the viewer
      }
    }
    if (generation === this.#generation) {
      this.#running = false;
    }
  }

  dismiss(assetId: string) {
    this.offers = this.offers.filter((offer) => offer.assetId !== assetId);
  }

  reset() {
    this.#generation++;
    this.#running = false;
    this.#queue = [];
    this.#seen.clear();
    this.offers = [];
  }
}

export const scanOffers = new ScanOffers();
