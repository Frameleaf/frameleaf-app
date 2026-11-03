type Candidate = { faceId: string; overlap: number };

/** Maximize retained identities using layered augmenting paths, preferring closer candidate edges. */
export const assignFaceCandidates = (candidates: readonly (readonly Candidate[])[]): Map<number, string> => {
  const rows = candidates.map((row) =>
    [...row].sort((a, b) => b.overlap - a.overlap || a.faceId.localeCompare(b.faceId)),
  );
  const byDetection = new Map<number, string>();
  const byFace = new Map<string, number>();
  const distance = new Int32Array(rows.length);
  const next = new Int32Array(rows.length);

  for (;;) {
    distance.fill(-1);
    const queue: number[] = [];
    for (let index = 0; index < rows.length; index++) {
      if (!byDetection.has(index)) {
        distance[index] = 0;
        queue.push(index);
      }
    }
    let shortest = Infinity;
    for (let head = 0; head < queue.length; head++) {
      const detection = queue[head];
      if (distance[detection] >= shortest) continue;
      for (const { faceId } of rows[detection]) {
        const owner = byFace.get(faceId);
        if (owner === undefined) shortest = distance[detection] + 1;
        else if (distance[owner] < 0) {
          distance[owner] = distance[detection] + 1;
          queue.push(owner);
        }
      }
    }
    if (shortest === Infinity) return byDetection;
    next.fill(0);
    let augmented = false;

    for (const start of queue) {
      if (distance[start] !== 0 || byDetection.has(start)) continue;
      const path = [start];
      const edges: string[] = [];
      while (path.length > 0) {
        const detection = path.at(-1)!;
        let advanced = false;
        while (next[detection] < rows[detection].length) {
          const { faceId } = rows[detection][next[detection]++];
          const owner = byFace.get(faceId);
          if (owner === undefined && distance[detection] + 1 === shortest) {
            byDetection.set(detection, faceId);
            byFace.set(faceId, detection);
            for (let level = path.length - 2; level >= 0; level--) {
              byDetection.set(path[level], edges[level]);
              byFace.set(edges[level], path[level]);
            }
            augmented = true;
            path.length = 0;
            advanced = true;
            break;
          }
          if (owner !== undefined && distance[owner] === distance[detection] + 1) {
            edges.push(faceId);
            path.push(owner);
            advanced = true;
            break;
          }
        }
        if (!advanced) {
          distance[detection] = -1;
          path.pop();
          edges.pop();
        }
      }
    }
    if (!augmented) throw new Error('Face assignment could not preserve a reachable identity');
  }
};
