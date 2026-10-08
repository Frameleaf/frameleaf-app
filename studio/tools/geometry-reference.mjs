// Independent pinned coordinates and premultiplied bilinear light; no production imports.
export const HDR_GEOMETRY = ['gpu-twirl', 'gpu-wave', 'gpu-bulge'];

export function geometryReference(values, width, height, type, params) {
  return Array.from({ length: width * height }, (_, i) => {
    let u = (i % width + .5) / width, v = (Math.floor(i / width) + .5) / height;
    if (type === 'gpu-wave') {
      v += Math.sin(u * params.frequencyX * 2 * Math.PI) * params.amplitudeX;
      u += Math.sin(v * params.frequencyY * 2 * Math.PI) * params.amplitudeY;
    } else {
      const dx = u - params.centerX, dy = v - params.centerY, distance = Math.hypot(dx, dy);
      if (distance < params.radius) {
        if (type === 'gpu-twirl') {
          const factor = 1 - Math.min(distance / Math.max(params.radius, .0001), 1);
          const angle = params.amount * factor * factor;
          u = params.centerX + dx * Math.cos(angle) - dy * Math.sin(angle);
          v = params.centerY + dx * Math.sin(angle) + dy * Math.cos(angle);
        } else if (distance > 0) {
          const safe = Math.max(distance, .0001), next = (safe / params.radius) ** params.amount * params.radius;
          u = params.centerX + dx / safe * next;
          v = params.centerY + dy / safe * next;
        }
      }
    }
    const x = u * width - .5, y = v * height - .5;
    const left = Math.floor(x), top = Math.floor(y), fx = x - left, fy = y - top;
    const sum = [0, 0, 0, 0];
    for (const [dx, dy, weight] of [[0,0,(1-fx)*(1-fy)], [1,0,fx*(1-fy)], [0,1,(1-fx)*fy], [1,1,fx*fy]]) {
      const at = (Math.max(0, Math.min(height-1, top+dy)) * width + Math.max(0, Math.min(width-1, left+dx))) * 4;
      const alpha = values[at+3];
      sum[3] += alpha * weight;
      for (let c = 0; c < 3; c++) sum[c] += values[at+c] * alpha * weight;
    }
    const coverage = new Float16Array([Math.max(0, Math.min(1, sum[3]))])[0];
    return coverage > 0 ? [...sum.slice(0,3).map(value => Math.max(-65504, Math.min(65504, value/sum[3]))), coverage] : [0,0,0,0];
  }).flat();
}
