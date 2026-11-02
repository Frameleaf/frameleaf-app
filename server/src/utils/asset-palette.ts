export type PaletteSwatch = { hex: string; weight: number; oklab: [number, number, number] };

/** D65 sRGB → Oklab: https://www.w3.org/TR/css-color-4/#color-conversion-code (normalized sRGB inputs). */
export function rgbToOklab(r: number, g: number, b: number): [number, number, number] {
  if ([r, g, b].some((value) => !Number.isFinite(value) || value < 0 || value > 1)) {
    throw new Error('Palette channels must be normalized sRGB');
  }
  const linear = (value: number) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  const red = linear(r),
    green = linear(g),
    blue = linear(b);
  const x = 0.4123907992659595 * red + 0.357584339383878 * green + 0.1804807884018343 * blue;
  const y = 0.2126390058715104 * red + 0.715168678767756 * green + 0.0721923153607337 * blue;
  const z = 0.0193308187155918 * red + 0.119194779794626 * green + 0.9505321522496606 * blue;
  const l = Math.cbrt(0.819022437996703 * x + 0.3619062600528904 * y - 0.1288737815209879 * z);
  const m = Math.cbrt(0.0329836539323885 * x + 0.9292868615863434 * y + 0.0361446663506424 * z);
  const s = Math.cbrt(0.0481771893596242 * x + 0.2642395317527308 * y + 0.6335478284694309 * z);
  return [
    0.210454268309314 * l + 0.7936177747023054 * m - 0.0040720430116193 * s,
    1.9779985324311684 * l - 2.4285922420485799 * m + 0.450593709617411 * s,
    0.0259040424655478 * l + 0.7827717124575296 * m - 0.8086757549230774 * s,
  ];
}

/** At most 32768 histogram buckets and eight linear merge passes over a 256×256 RGBA surface. */
export function extractPalette(rgba: Uint8Array, width: number, height: number): PaletteSwatch[] {
  if (
    [width, height].some((size) => !(Number.isSafeInteger(size) && size > 0 && size <= 256)) ||
    rgba.length !== width * height * 4
  ) {
    throw new Error('Palette requires an RGBA surface within 256×256');
  }
  const histogram = new Map<number, { weight: number; rgb: number[] }>();
  let total = 0;
  for (let index = 0; index < rgba.length; index += 4) {
    const alpha = rgba[index + 3];
    if (alpha === 0) continue;
    const key = ((rgba[index] >> 3) << 10) | ((rgba[index + 1] >> 3) << 5) | (rgba[index + 2] >> 3);
    const bucket = histogram.get(key) ?? { weight: 0, rgb: [0, 0, 0] };
    bucket.weight += alpha;
    for (let channel = 0; channel < 3; channel++) bucket.rgb[channel] += rgba[index + channel] * alpha;
    histogram.set(key, bucket);
    total += alpha;
  }
  const buckets = [...histogram]
    .sort(([a, left], [b, right]) => right.weight - left.weight || a - b)
    .map(([, bucket]) => {
      const rgb = bucket.rgb.map((value) => value / bucket.weight / 255);
      return { ...bucket, oklab: rgbToOklab(rgb[0], rgb[1], rgb[2]), used: false };
    });
  const swatches: PaletteSwatch[] = [];
  for (const seed of buckets) {
    if (seed.used) continue;
    if (swatches.length === 8) break;
    let weight = 0;
    const rgb = [0, 0, 0];
    for (const bucket of buckets) {
      if (bucket.used || Math.hypot(...bucket.oklab.map((value, index) => value - seed.oklab[index])) > 0.03) continue;
      bucket.used = true;
      weight += bucket.weight;
      for (let channel = 0; channel < 3; channel++) rgb[channel] += bucket.rgb[channel];
    }
    const channels = rgb.map((value) => Math.round(value / weight));
    swatches.push({
      hex: `#${channels.map((value) => value.toString(16).padStart(2, '0')).join('')}`,
      weight: weight / total,
      oklab: rgbToOklab(channels[0] / 255, channels[1] / 255, channels[2] / 255),
    });
  }
  return swatches.sort((a, b) => b.weight - a.weight || a.hex.localeCompare(b.hex));
}
