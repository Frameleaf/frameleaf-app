/**
 * Grade sidecars that travel with an exported timeline (FL-1547): ASC CDL files (`.cdl`, `.cc`, `.ccc`)
 * and `.cube` LUTs. Each applies to the clips it names: a CDL's `id` or a LUT's file name matches a
 * clip's name, its media's file name (with or without the extension) or, for an EDL, its reel.
 *
 * A LUT is stored the way Studio's LUT effect reads it: a 3D table, red fastest, RGBA8, base64. A 1D
 * LUT becomes the equivalent 3D table, and a table larger than 65 points a side is resampled to 65.
 */
import type { Cdl, Clip, ClipGrade, InterchangeProject, Stack, Track } from 'src/utils/studio-interchange/model.js';
import { InterchangeNotice, InterchangeReadError } from 'src/utils/studio-interchange/readers/common.js';
import { XmlNode, parseXml } from 'src/utils/studio-interchange/xml.js';

const MAX_CUBE_BYTES = 64 * 1024 * 1024;
const MAX_STORED_SIZE = 65;
const ONE_D_SIZE = 33;

const localName = (node: XmlNode) => node.name.split(':').at(-1) ?? node.name;
const find = (node: XmlNode, name: string) => node.children.find((item) => localName(item) === name);
const numbers = (value: string | undefined, count: number) => {
  const parts = value?.trim().split(/\s+/).map(Number) ?? [];
  return parts.length === count && parts.every((part) => Number.isFinite(part)) ? parts : null;
};

/** Every colour correction in a CDL, CC or CCC file, by id. */
export const readCdlFile = (bytes: Buffer | string): Map<string, Cdl> => {
  const root = parseXml(bytes, { maxBytes: 16 * 1024 * 1024, maxDepth: 32, maxElements: 200_000 });
  const corrections: XmlNode[] = [];
  const collect = (node: XmlNode) => {
    if (localName(node) === 'ColorCorrection') {
      corrections.push(node);
      return;
    }
    for (const item of node.children) {
      collect(item);
    }
  };
  collect(root);
  const found = new Map<string, Cdl>();
  for (const [index, correction] of corrections.entries()) {
    const sop = find(correction, 'SOPNode');
    const slope = numbers(sop && find(sop, 'Slope')?.text, 3);
    const offset = numbers(sop && find(sop, 'Offset')?.text, 3);
    const power = numbers(sop && find(sop, 'Power')?.text, 3);
    const sat = find(correction, 'SatNode');
    const saturation = Number(sat && find(sat, 'Saturation')?.text.trim());
    if (!slope && !offset && !power && !Number.isFinite(saturation)) {
      continue;
    }
    found.set(correction.attributes.id?.trim() || String(index + 1), {
      slope: (slope ?? [1, 1, 1]) as Cdl['slope'],
      offset: (offset ?? [0, 0, 0]) as Cdl['offset'],
      power: (power ?? [1, 1, 1]) as Cdl['power'],
      saturation: Number.isFinite(saturation) ? saturation : 1,
    });
  }
  if (found.size === 0) {
    throw new InterchangeReadError('empty', 'This CDL file has no colour correction in it');
  }
  return found;
};

type Table = { size: number; data: Float32Array };

/** Trilinear lookup into a 3D table (red fastest), input 0..1. */
const sample = (table: Table, r: number, g: number, b: number, out: Float32Array) => {
  const last = table.size - 1;
  const position = (value: number) => Math.max(0, Math.min(last, value * last));
  const [x, y, z] = [position(r), position(g), position(b)];
  const [x0, y0, z0] = [Math.floor(x), Math.floor(y), Math.floor(z)];
  const [x1, y1, z1] = [Math.min(last, x0 + 1), Math.min(last, y0 + 1), Math.min(last, z0 + 1)];
  const [fx, fy, fz] = [x - x0, y - y0, z - z0];
  const at = (i: number, j: number, k: number, channel: number) =>
    table.data[((k * table.size + j) * table.size + i) * 3 + channel];
  for (let channel = 0; channel < 3; channel++) {
    const c00 = at(x0, y0, z0, channel) * (1 - fx) + at(x1, y0, z0, channel) * fx;
    const c10 = at(x0, y1, z0, channel) * (1 - fx) + at(x1, y1, z0, channel) * fx;
    const c01 = at(x0, y0, z1, channel) * (1 - fx) + at(x1, y0, z1, channel) * fx;
    const c11 = at(x0, y1, z1, channel) * (1 - fx) + at(x1, y1, z1, channel) * fx;
    out[channel] = (c00 * (1 - fy) + c10 * fy) * (1 - fz) + (c01 * (1 - fy) + c11 * fy) * fz;
  }
};

/** A `.cube` LUT as Studio stores it, and whether it had to be resampled. */
export const readCubeFile = (
  bytes: Buffer | string,
  name: string,
): { lut: NonNullable<ClipGrade['lut']>; resampled: boolean } => {
  const length = typeof bytes === 'string' ? Buffer.byteLength(bytes) : bytes.length;
  if (length > MAX_CUBE_BYTES) {
    throw new InterchangeReadError('too-large', 'The LUT file is too large to read');
  }
  let size3 = 0;
  let size1 = 0;
  let title = '';
  let domainMin = [0, 0, 0];
  let domainMax = [1, 1, 1];
  const values: number[] = [];
  for (const raw of (typeof bytes === 'string' ? bytes : bytes.toString('utf8')).split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const [keyword, ...rest] = line.split(/\s+/);
    switch (keyword.toUpperCase()) {
      case 'TITLE': {
        title = rest.join(' ').replaceAll('"', '').trim();
        break;
      }
      case 'LUT_3D_SIZE': {
        size3 = Number(rest[0]);
        break;
      }
      case 'LUT_1D_SIZE': {
        size1 = Number(rest[0]);
        break;
      }
      case 'DOMAIN_MIN': {
        domainMin = rest.map(Number);
        break;
      }
      case 'DOMAIN_MAX': {
        domainMax = rest.map(Number);
        break;
      }
      case 'LUT_1D_INPUT_RANGE':
      case 'LUT_3D_INPUT_RANGE': {
        domainMin = [Number(rest[0]), Number(rest[0]), Number(rest[0])];
        domainMax = [Number(rest[1]), Number(rest[1]), Number(rest[1])];
        break;
      }
      default: {
        const triple = numbers(line, 3);
        if (!triple) {
          throw new InterchangeReadError('malformed', 'This LUT file has a line Frameleaf cannot read');
        }
        values.push(...triple);
      }
    }
  }
  const valid = (value: number, max: number) => Number.isSafeInteger(value) && value >= 2 && value <= max;
  if (!(valid(size3, 256) || valid(size1, 65_536)) || (size3 && size1)) {
    throw new InterchangeReadError('malformed', 'This LUT file does not say its size');
  }
  const expected = size3 ? size3 ** 3 * 3 : size1 * 3;
  if (values.length !== expected) {
    throw new InterchangeReadError('malformed', 'This LUT file has the wrong number of entries for its size');
  }
  const span = [0, 1, 2].map((channel) => (domainMax[channel] ?? 1) - (domainMin[channel] ?? 0));
  if (span.some((value) => !(value > 0))) {
    throw new InterchangeReadError('malformed', 'This LUT file has an empty input range');
  }
  const data = Float32Array.from(values);
  const toDomain = (value: number, channel: number) => (value - (domainMin[channel] ?? 0)) / span[channel];
  const size = size3 ? Math.min(size3, MAX_STORED_SIZE) : ONE_D_SIZE;
  const resampled = size3 > MAX_STORED_SIZE;
  const domainIsUnit = span.every((value, channel) => value === 1 && (domainMin[channel] ?? 0) === 0);
  const bytesOut = Buffer.alloc(size ** 3 * 4);
  const colour = new Float32Array(3);
  const table: Table = { size: size3, data };
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        const input = [r / (size - 1), g / (size - 1), b / (size - 1)];
        if (size3) {
          if (!resampled && domainIsUnit) {
            const index = ((b * size + g) * size + r) * 3;
            colour.set(data.subarray(index, index + 3));
          } else {
            sample(table, toDomain(input[0], 0), toDomain(input[1], 1), toDomain(input[2], 2), colour);
          }
        } else {
          for (let channel = 0; channel < 3; channel++) {
            const position = Math.max(0, Math.min(size1 - 1, toDomain(input[channel], channel) * (size1 - 1)));
            const low = Math.floor(position);
            const high = Math.min(size1 - 1, low + 1);
            colour[channel] =
              data[low * 3 + channel] * (1 - (position - low)) + data[high * 3 + channel] * (position - low);
          }
        }
        const offset = ((b * size + g) * size + r) * 4;
        for (let channel = 0; channel < 3; channel++) {
          bytesOut[offset + channel] = Math.round(Math.max(0, Math.min(1, colour[channel])) * 255);
        }
        bytesOut[offset + 3] = 255;
      }
    }
  }
  return { lut: { name: title || name, size, data: bytesOut.toString('base64') }, resampled };
};

export type InterchangeSidecar = { name: string; bytes: Buffer };

const stem = (name: string) => name.replace(/\.[^./\\]+$/, '').toLowerCase();

/** Names a sidecar may use for a clip. */
const namesOf = (clip: Clip) => {
  const names = new Set<string>([clip.name.toLowerCase(), stem(clip.name)]);
  const reference = clip.mediaReference;
  if (reference.kind !== 'generator') {
    names.add(reference.name.toLowerCase());
    names.add(stem(reference.name));
  }
  const edl = clip.metadata?.edl as { reel?: unknown } | undefined;
  if (typeof edl?.reel === 'string') {
    names.add(edl.reel.toLowerCase());
  }
  return names;
};

const clipsOf = (tracks: readonly Track[], into: Clip[] = []): Clip[] => {
  for (const track of tracks) {
    for (const item of track.children) {
      if (item.type === 'clip' && track.kind === 'video') {
        into.push(item);
      } else if (item.type === 'stack') {
        clipsOf((item as Stack).tracks, into);
      }
    }
  }
  return into;
};

/**
 * Applies CDL and LUT sidecars to the clips they name, in place. A sidecar that names no clip, or
 * cannot be read, is reported rather than dropped without a word.
 */
export const applySidecars = (project: InterchangeProject, sidecars: readonly InterchangeSidecar[]) => {
  const notices: InterchangeNotice[] = [];
  const clips = project.timelines.flatMap((timeline) => clipsOf(timeline.tracks));
  const apply = (id: string, grade: (current: ClipGrade) => ClipGrade) => {
    const key = id.toLowerCase();
    const matched = clips.filter((clip) => namesOf(clip).has(key) || namesOf(clip).has(stem(key)));
    for (const clip of matched) {
      clip.frameleaf = { ...clip.frameleaf, grade: grade(clip.frameleaf?.grade ?? {}) };
    }
    return matched.length;
  };
  for (const sidecar of sidecars) {
    const extension = sidecar.name.split('.').at(-1)?.toLowerCase();
    try {
      if (extension === 'cube') {
        const { lut, resampled } = readCubeFile(sidecar.bytes, stem(sidecar.name));
        const used = apply(sidecar.name, (current) => ({ ...current, lut }));
        if (used === 0) {
          notices.push({
            code: 'sidecar-unused',
            what: sidecar.name,
            became: 'Not used: it names no clip in this project',
          });
        } else if (resampled) {
          notices.push({
            code: 'format-limits',
            what: `${sidecar.name}, a large LUT`,
            became: `Kept at ${MAX_STORED_SIZE} points a side, which looks the same on almost every picture`,
          });
        }
      } else if (extension && ['cdl', 'cc', 'ccc'].includes(extension)) {
        const corrections = readCdlFile(sidecar.bytes);
        const single = corrections.size === 1 ? corrections.values().next().value : undefined;
        let used = 0;
        for (const [id, cdl] of corrections) {
          used += apply(id, (current) => ({ ...current, cdl }));
        }
        // A file holding one correction may name its clip by its own file name instead.
        if (used === 0 && single) {
          used = apply(sidecar.name, (current) => ({ ...current, cdl: single }));
        }
        if (used === 0) {
          notices.push({
            code: 'sidecar-unused',
            what: sidecar.name,
            became: 'Not used: it names no clip in this project',
          });
        }
      } else {
        notices.push({
          code: 'sidecar-unused',
          what: sidecar.name,
          became: 'Not used: Frameleaf reads CDL and LUT files beside a project',
        });
      }
    } catch (error) {
      notices.push({
        code: 'sidecar-unused',
        what: sidecar.name,
        became: error instanceof InterchangeReadError ? `Not used: ${error.message}` : 'Not used: it could not be read',
      });
    }
  }
  if (notices.length > 0) {
    project.notices = [...(project.notices ?? []), ...notices];
  }
  return project;
};
