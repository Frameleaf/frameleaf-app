export type PrintScan = { assetId: string; name: string };
export type PrintPair = { front: PrintScan; back: PrintScan };

const byScanOrder = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/**
 * FL-967: reads a batch of scans as front, back, front, back, in file-name order (scanners number their files).
 * This is an assumption about the order, not a look at the pictures, so the owner reviews every pair. An odd
 * count cannot alternate and gets no offer.
 */
export const alternatingPairs = (scans: PrintScan[]): PrintPair[] => {
  if (scans.length < 2 || scans.length % 2 !== 0) {
    return [];
  }
  const ordered = [...scans].sort((a, b) => byScanOrder.compare(a.name, b.name));
  const pairs: PrintPair[] = [];
  for (let index = 0; index < ordered.length; index += 2) {
    pairs.push({ front: ordered[index], back: ordered[index + 1] });
  }
  return pairs;
};

export const swapPair = ({ front, back }: PrintPair): PrintPair => ({ front: back, back: front });
