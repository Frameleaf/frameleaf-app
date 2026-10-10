import { PNG } from 'pngjs';

const createPNG = (r: number, g: number, b: number, width: number, height: number) => {
  const image = new PNG({ width, height });
  for (let index = 0; index < image.data.length; index += 4) {
    image.data[index] = r;
    image.data[index + 1] = g;
    image.data[index + 2] = b;
    image.data[index + 3] = 255;
  }
  return PNG.sync.write(image);
};

function* newPngFactory() {
  for (let r = 0; r < 255; r++) {
    for (let g = 0; g < 255; g++) {
      for (let b = 0; b < 255; b++) {
        yield [r, g, b] as const;
      }
    }
  }
}

const pngFactory = newPngFactory();

export const makeRandomImage = (width = 1, height = 1) => {
  const { value } = pngFactory.next();
  if (!value) {
    throw new Error('Ran out of random asset data');
  }
  return createPNG(...value, width, height);
};
