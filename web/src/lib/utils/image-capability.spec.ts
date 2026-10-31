const images: EventTarget[] = [];
const loadModule = () => import('./asset-utils');
const compatible = (module: Awaited<ReturnType<typeof loadModule>>, originalMimeType: string) =>
  module.isWebCompatibleImage({ originalMimeType } as never);

beforeEach(() => {
  vi.resetModules();
  images.length = 0;
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Chrome');
  vi.stubGlobal('isSecureContext', true);
  vi.stubGlobal(
    'Image',
    class extends EventTarget {
      src = '';
      constructor() {
        super();
        images.push(this);
      }
    },
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('detects HEIC without waiting for the JPEG XL capability probe', async () => {
  let resolve!: (supported: boolean) => void;
  const pending = new Promise<boolean>((done) => {
    resolve = done;
  });
  vi.stubGlobal('ImageDecoder', {
    isTypeSupported: vi.fn((type: string) => (type === 'image/jxl' ? pending : Promise.resolve(true))),
  });
  const module = await loadModule();
  try {
    await vi.waitFor(() => expect(compatible(module, 'image/heic')).toBe(true), { timeout: 300 });
    expect(compatible(module, 'image/heif')).toBe(true);
  } finally {
    resolve(false);
  }
});

it('falls back only for a rejected codec probe and keeps successful codec results', async () => {
  vi.stubGlobal('ImageDecoder', {
    isTypeSupported: vi.fn((type: string) =>
      type === 'image/jxl' ? Promise.reject(new Error('unavailable')) : Promise.resolve(true),
    ),
  });
  const module = await loadModule();
  await vi.waitFor(() => expect(images).toHaveLength(1));
  expect(compatible(module, 'image/heic')).toBe(true);
  expect(compatible(module, 'image/jxl')).toBe(false);
  images[0].dispatchEvent(new Event('load'));
  expect(compatible(module, 'image/jxl')).toBe(true);
});

it('retains negative capability results without marking a codec as supported', async () => {
  const probe = vi.fn(() => Promise.resolve(false));
  vi.stubGlobal('ImageDecoder', { isTypeSupported: probe });
  const module = await loadModule();
  await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2));
  expect(compatible(module, 'image/heic')).toBe(false);
  expect(images).toHaveLength(0);
});

it('uses image samples outside a secure context and enables matching HEIF aliases', async () => {
  vi.stubGlobal('isSecureContext', false);
  const probe = vi.fn();
  vi.stubGlobal('ImageDecoder', { isTypeSupported: probe });
  const module = await loadModule();
  expect(probe).not.toHaveBeenCalled();
  expect(images).toHaveLength(2);
  images[1].dispatchEvent(new Event('load'));
  expect(compatible(module, 'image/heic')).toBe(true);
  expect(compatible(module, 'image/heif')).toBe(true);
});

it.each([16, 17])('preserves the Safari %i capability boundary', async (version) => {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(`Version/${version}.0 Safari`);
  const probe = vi.fn();
  vi.stubGlobal('ImageDecoder', { isTypeSupported: probe });
  const module = await loadModule();
  expect(compatible(module, 'image/jxl')).toBe(version >= 17);
  expect(compatible(module, 'image/heif')).toBe(version >= 17);
  expect(probe).not.toHaveBeenCalled();
  expect(images).toHaveLength(0);
});
