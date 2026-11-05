import { PhotographyError } from './errors';
import { watermarkPreview, type Watermark } from './workflow-api';

/** The two plain backgrounds the server draws its watermark previews on (`previewWatermark`). */
const light = [0xe8, 0xe4, 0xdc] as const;
const dark = [0x26, 0x33, 0x29] as const;

async function pixels(blob: Blob) {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext('2d', { willReadFrequently: true })!;
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  return { canvas, context, data: context.getImageData(0, 0, canvas.width, canvas.height) };
}

/**
 * The watermark on its own, as a transparent PNG, so it can be laid over one of the photographer's
 * own photographs. The server's renderer (the one that marks real proofs) draws it twice, on its light
 * and dark test backgrounds; where the two differ the mark lets the background through, which gives
 * each pixel's opacity and colour. Returns an object URL the caller revokes.
 */
export async function watermarkOverlay(watermark: Watermark, orientation: 'portrait' | 'landscape'): Promise<string> {
  const [onLight, onDark] = await Promise.all([
    watermarkPreview(watermark, orientation, 'light').then(pixels),
    watermarkPreview(watermark, orientation, 'dark').then(pixels),
  ]);
  const a = onLight.data.data;
  const b = onDark.data.data;
  const out = onLight.context.createImageData(onLight.canvas.width, onLight.canvas.height);
  const o = out.data;
  for (let index = 0; index < a.length; index += 4) {
    // How much of the background shows through, averaged over the three channels.
    let through = 0;
    for (let c = 0; c < 3; c++) {
      through += (a[index + c] - b[index + c]) / (light[c] - dark[c]);
    }
    let alpha = 1 - through / 3;
    // JPEG noise on the bare background is not part of the mark.
    alpha = alpha < 0.06 ? 0 : Math.min(1, alpha);
    if (alpha === 0) {
      continue;
    }
    const keep = 1 - alpha;
    for (let c = 0; c < 3; c++) {
      const fromLight = (a[index + c] - keep * light[c]) / alpha;
      const fromDark = (b[index + c] - keep * dark[c]) / alpha;
      o[index + c] = Math.max(0, Math.min(255, Math.round((fromLight + fromDark) / 2)));
    }
    o[index + 3] = Math.round(alpha * 255);
  }
  onLight.context.putImageData(out, 0, 0);
  const blob = await new Promise<Blob | null>((resolve) => onLight.canvas.toBlob(resolve, 'image/png'));
  if (!blob) {
    throw new PhotographyError('watermark_preview');
  }
  return URL.createObjectURL(blob);
}
