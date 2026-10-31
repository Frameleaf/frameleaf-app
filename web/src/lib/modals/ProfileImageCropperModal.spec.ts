import { hasTransparentPixels } from './profile-image';

const decode = vi.fn();
const drawImage = vi.fn();
const getImageData = vi.fn();

beforeEach(() => {
  decode.mockReset().mockResolvedValue(undefined);
  drawImage.mockReset();
  getImageData.mockReset().mockReturnValue({ data: new Uint8ClampedArray([1, 2, 3, 255]) });
  vi.stubGlobal(
    'Image',
    class {
      width = 1;
      height = 1;
      src = '';
      decode = decode;
    },
  );
  vi.stubGlobal(
    'URL',
    class extends URL {
      static override createObjectURL = vi.fn(() => 'blob:profile-fixture');
      static override revokeObjectURL = vi.fn();
    },
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage,
    getImageData,
  } as unknown as CanvasRenderingContext2D);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([
  { pixels: [1, 2, 3, 255, 4, 5, 6, 255], transparent: false },
  { pixels: [1, 2, 3, 255, 4, 5, 6, 254], transparent: true },
  { pixels: [0, 0, 0, 0, 4, 5, 6, 255], transparent: true },
])('detects alpha and releases the decoded URL (transparent=$transparent)', async ({ pixels, transparent }) => {
  getImageData.mockReturnValue({ data: new Uint8ClampedArray(pixels) });
  const blob = new Blob(['fixture']);
  await expect(hasTransparentPixels(blob)).resolves.toBe(transparent);
  expect(URL.createObjectURL).toHaveBeenCalledWith(blob);
  expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:profile-fixture');
});

it('releases the URL and preserves the decoder error', async () => {
  const failure = new Error('cannot decode image');
  decode.mockRejectedValue(failure);
  await expect(hasTransparentPixels(new Blob())).rejects.toBe(failure);
  expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:profile-fixture');
  expect(drawImage).not.toHaveBeenCalled();
});

it('releases the URL when canvas context is unavailable', async () => {
  vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(null);
  await expect(hasTransparentPixels(new Blob())).rejects.toThrow('Could not get canvas context.');
  expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:profile-fixture');
});

it('releases the URL when reading canvas pixels fails', async () => {
  const failure = new Error('pixel read failed');
  getImageData.mockImplementation(() => {
    throw failure;
  });
  await expect(hasTransparentPixels(new Blob())).rejects.toBe(failure);
  expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:profile-fixture');
});
