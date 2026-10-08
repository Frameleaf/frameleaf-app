// Independent CPU block-center sampling; no production shader or color helpers.
export function pixelateReference(values, width, height, { size }) {
  return Array.from({ length: width * height }, (_, i) => {
    const x = Math.floor((i % width + 0.5) / size) * size + size * 0.5 - 0.5;
    const y = Math.floor((Math.floor(i / width) + 0.5) / size) * size + size * 0.5 - 0.5;
    const left = Math.floor(x), top = Math.floor(y), fx = x - left, fy = y - top;
    const sum = [0, 0, 0, 0];
    for (const [dx, dy, weight] of [[0, 0, (1-fx)*(1-fy)], [1, 0, fx*(1-fy)], [0, 1, (1-fx)*fy], [1, 1, fx*fy]]) {
      const at = (Math.max(0, Math.min(height-1, top+dy)) * width + Math.max(0, Math.min(width-1, left+dx))) * 4;
      const alpha = values[at+3];
      sum[3] += alpha * weight;
      for (let c = 0; c < 3; c++) sum[c] += values[at+c] * alpha * weight;
    }
    return sum[3] > 0 ? [...sum.slice(0, 3).map(v => Math.max(-65504, Math.min(65504, v/sum[3]))), Math.max(0, Math.min(1, sum[3]))] : [0, 0, 0, 0];
  }).flat();
}
