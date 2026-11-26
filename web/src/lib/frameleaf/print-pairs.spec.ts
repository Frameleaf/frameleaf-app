import { alternatingPairs, swapPair } from '$lib/frameleaf/print-pairs';

const scan = (name: string) => ({ assetId: `id-${name}`, name });

describe('alternatingPairs', () => {
  it('reads scans as front, back in numeric file order, whatever order they finished uploading', () => {
    const pairs = alternatingPairs([scan('Scan 10.jpg'), scan('Scan 9.jpg'), scan('Scan 12.jpg'), scan('Scan 11.jpg')]);

    expect(pairs.map(({ front, back }) => [front.name, back.name])).toEqual([
      ['Scan 9.jpg', 'Scan 10.jpg'],
      ['Scan 11.jpg', 'Scan 12.jpg'],
    ]);
  });

  it.each([[[]], [[scan('a')]], [[scan('a'), scan('b'), scan('c')]]])('offers nothing for %j', (scans) => {
    expect(alternatingPairs(scans)).toEqual([]);
  });

  it('swaps a pair', () => {
    expect(swapPair({ front: scan('a'), back: scan('b') })).toEqual({ front: scan('b'), back: scan('a') });
  });
});
