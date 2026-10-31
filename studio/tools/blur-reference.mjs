// Independent CPU reference for the pinned spatial kernels. No production shader/helpers.
export const HDR_BLURS = ['gpu-box-blur', 'gpu-gaussian-blur', 'gpu-motion-blur'];

export function blurReference(values, width, height, type, params) {
  const load = (x, y) => {
    const at = (Math.max(0, Math.min(height - 1, y)) * width + Math.max(0, Math.min(width - 1, x))) * 4;
    const a = values[at + 3];
    return [values[at] * a, values[at + 1] * a, values[at + 2] * a, a];
  };
  const sample = (x, y) => {
    const left = Math.floor(x), top = Math.floor(y), fx = x - left, fy = y - top;
    const corners = [load(left, top), load(left + 1, top), load(left, top + 1), load(left + 1, top + 1)];
    return corners[0].map((_, c) => (corners[0][c] * (1 - fx) + corners[1][c] * fx) * (1 - fy) +
      (corners[2][c] * (1 - fx) + corners[3][c] * fx) * fy);
  };
  const taps = [];
  if (type === 'gpu-motion-blur') {
    const radius = Math.min(Math.max(params.amount, 0) * (params.shutterAngle ?? 360) / 360, 0.2);
    if (radius < 0.001) return [...values];
    const count = Math.trunc(Math.max(4, Math.min(32, params.samples)));
    for (let i = 0; i < count; ++i) {
      const t = (i / (count - 1) - 0.5) * 2;
      taps.push([Math.cos(params.angle) * t * radius * width, Math.sin(params.angle) * t * radius * height, Math.exp(-t * t * 2)]);
    }
  } else {
    if (params.radius < 0.5) return [...values];
    const n = Math.trunc(type === 'gpu-box-blur' ? params.radius : Math.max(1, Math.min(64, params.samples)));
    for (let x = -n; x <= n; ++x)
      for (let y = -n; y <= n; ++y)
        taps.push(type === 'gpu-box-blur' ? [x, y, 1] :
          [x * params.radius / n, y * params.radius / n, Math.exp(-(x * x + y * y) / (2 * (params.radius / 3) ** 2))]);
  }
  const weight = taps.reduce((total, tap) => total + tap[2], 0);
  return Array.from({ length: width * height }, (_, i) => {
    const accumulated = [0, 0, 0, 0];
    for (const [dx, dy, w] of taps) {
      const pixel = sample(i % width + dx, Math.floor(i / width) + dy);
      pixel.forEach((v, c) => { accumulated[c] += v * w; });
    }
    const alpha = accumulated[3] / weight;
    const coverage = Number(new Float16Array([Math.max(0, Math.min(1, alpha))])[0]);
    return coverage > 0 ? [...accumulated.slice(0, 3).map(v => Math.max(-65504, Math.min(65504, v / accumulated[3]))), coverage] : [0,0,0,0];
  }).flat();
}
