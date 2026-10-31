import { downloadJson, getAssetUrl } from '$lib/utils';
import { assetFactory } from '@test-data/factories/asset-factory';

let parts: BlobPart[] = [];
beforeEach(() => {
  parts = [];
  vi.useFakeTimers();
  vi.stubGlobal(
    'Blob',
    class extends Blob {
      constructor(data?: BlobPart[], options?: BlobPropertyBag) {
        super(data, options);
        parts = data ?? [];
      }
    },
  );
  vi.stubGlobal(
    'URL',
    class extends URL {
      static override createObjectURL = vi.fn(() => 'blob:json-fixture');
      static override revokeObjectURL = vi.fn();
    },
  );
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
});
afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('retains prototype-like JSON keys as ordinary data at every level', () => {
  const data = JSON.parse('{"__proto__":{"retained":true},"z":1,"nested":{"__proto__":{"value":"kept"},"b":2}}');
  downloadJson(data, 'fixture.json');
  const decoded = JSON.parse(parts[0] as string);
  expect(decoded).toEqual(data);
  expect(Object.hasOwn(decoded, '__proto__')).toBe(true);
  expect(Object.hasOwn(decoded.nested, '__proto__')).toBe(true);
  expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
});

it('keeps sorted object keys, array ordering, JSON dates and missing-value semantics', () => {
  downloadJson(
    {
      z: 0,
      a: { y: false, b: null },
      items: [3, { z: 2, a: 1 }],
      date: new Date('2024-01-02T03:04:05Z'),
      missing: undefined,
    },
    'fixture.json',
  );
  expect(parts[0]).toBe(
    JSON.stringify(
      { a: { b: null, y: false }, date: '2024-01-02T03:04:05.000Z', items: [3, { a: 1, z: 2 }], z: 0 },
      null,
      2,
    ),
  );
});

it('propagates non-serializable data errors before creating a download URL', () => {
  expect(() => downloadJson({ big: 1n }, 'fixture.json')).toThrow(TypeError);
  expect(URL.createObjectURL).not.toHaveBeenCalled();
});

it('does not serialize inherited query properties into an asset URL', () => {
  const asset = assetFactory.build();
  let url: string | undefined;
  Object.defineProperty(Object.prototype, 'inheritedQueryFixture', {
    value: 'should-not-be-sent',
    enumerable: true,
    configurable: true,
  });
  try {
    url = getAssetUrl({ asset });
  } finally {
    Reflect.deleteProperty(Object.prototype, 'inheritedQueryFixture');
  }
  expect(new URL(url!, 'https://example.test').searchParams.has('inheritedQueryFixture')).toBe(false);
});
