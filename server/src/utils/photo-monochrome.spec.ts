import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { AssetFileType } from 'src/enum.js';
import {
  ALREADY_IN_COLOUR,
  HAND_TINTED,
  classifyPhotoColour,
  colourRefusalReason,
  offToneShare,
  photoColourRefusal,
} from 'src/utils/photo-monochrome.js';

type Vector = {
  name: string;
  width: number;
  height: number;
  rgb: string;
  outerShare: number;
  innerShare: number;
  colour: string;
};

// The colourise runtime wrote these answers; its own test reads the same file.
const { vectors } = JSON.parse(
  readFileSync(
    new URL('../../../machine-learning/video-restoration/qualification/tint-vectors.json', import.meta.url),
    'utf8',
  ),
) as { vectors: Vector[] };

const imageOf = (vector: Vector) => ({
  data: new Uint8Array(inflateSync(Buffer.from(vector.rgb, 'base64'))),
  width: vector.width,
  height: vector.height,
  channels: 3,
});

describe('the colour rule shared with the worker', () => {
  it.each(vectors.map((vector) => [vector.name, vector] as const))('%s gets the same answer', (_name, vector) => {
    const image = imageOf(vector);

    expect(classifyPhotoColour(image)).toBe(vector.colour);
    expect(Math.abs(offToneShare(image, 0.15) - vector.outerShare)).toBeLessThan(0.01);
    expect(Math.abs(offToneShare(image, 0.25) - vector.innerShare)).toBeLessThan(0.01);
  });

  it('reads past an alpha channel', () => {
    const vector = vectors.find(({ name }) => name === 'colour')!;
    const { data, width, height } = imageOf(vector);
    const withAlpha = new Uint8Array(width * height * 4);
    for (let pixel = 0; pixel < width * height; pixel++) {
      withAlpha.set([data[pixel * 3], data[pixel * 3 + 1], data[pixel * 3 + 2], 255], pixel * 4);
    }

    expect(classifyPhotoColour({ data: withAlpha, width, height, channels: 4 })).toBe('in-colour');
  });

  it('treats a one-channel image as black and white', () => {
    expect(classifyPhotoColour({ data: new Uint8Array(4), width: 2, height: 2, channels: 1 })).toBe('monochrome');
  });
});

describe('photoColourRefusal', () => {
  const files = [{ id: 'preview', type: AssetFileType.Preview, path: '/preview.jpg', isEdited: false }] as never;
  const refusalFor = (name: string, allowHandTinted?: boolean) => {
    const image = imageOf(vectors.find((vector) => vector.name === name)!);
    const media = {
      decodeImage: vi.fn().mockResolvedValue({
        data: image.data,
        info: { width: image.width, height: image.height, channels: 3 },
      }),
    };
    return photoColourRefusal(media as never, { warn: vi.fn() }, 'asset', files, allowHandTinted);
  };

  it('accepts sepia', async () => {
    await expect(refusalFor('sepia')).resolves.toBeNull();
  });

  it('refuses a hand-tinted print unless the owner overrides it', async () => {
    await expect(refusalFor('light-paint')).resolves.toBe(HAND_TINTED);
    await expect(refusalFor('light-paint', true)).resolves.toBeNull();
  });

  it('refuses a colour photo even with the override', async () => {
    await expect(refusalFor('colour', true)).resolves.toBe(ALREADY_IN_COLOUR);
  });

  it('names each refusal with a stable word', () => {
    expect(colourRefusalReason(HAND_TINTED)).toBe('hand-tinted');
    expect(colourRefusalReason(ALREADY_IN_COLOUR)).toBe('already-in-colour');
    expect(colourRefusalReason('anything else')).toBe('colour-unknown');
  });
});
