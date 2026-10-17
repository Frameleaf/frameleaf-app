import { copyImageToClipboard } from './asset-utils';

describe('copyImageToClipboard', () => {
  let callback: BlobCallback;
  let blob: Promise<Blob>;
  const drawImage = vi.fn();
  const write = vi.fn(() => blob.then(() => undefined));

  beforeEach(() => {
    drawImage.mockClear();
    write.mockClear();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage,
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((next) => {
      callback = next;
    });
    vi.stubGlobal('navigator', { clipboard: { write } });
    vi.stubGlobal(
      'ClipboardItem',
      class {
        constructor(data: Record<string, Promise<Blob>>) {
          blob = data['image/png'];
        }
      },
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('starts the clipboard write within the click and waits for canvas encoding', async () => {
    const source = new Image();
    const copying = copyImageToClipboard(source);
    expect(write).toHaveBeenCalledTimes(1);
    expect(drawImage).toHaveBeenCalledWith(source, 0, 0);
    const encoded = new Blob(['image'], { type: 'image/png' });
    callback(encoded);
    await expect(copying).resolves.toBeUndefined();
    await expect(blob).resolves.toBe(encoded);
  });

  it('rejects the clipboard operation when the asynchronous encoder returns no blob', async () => {
    const copying = copyImageToClipboard(new Image());
    const rejection = expect(copying).rejects.toThrow('Canvas conversion to Blob failed');
    expect(() => callback(null)).not.toThrow();
    await rejection;
  });

  it('rejects the clipboard operation when no canvas context is available', async () => {
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(null);
    await expect(copyImageToClipboard(new Image())).rejects.toThrow('Canvas context is null');
    expect(HTMLCanvasElement.prototype.toBlob).not.toHaveBeenCalled();
  });
});
