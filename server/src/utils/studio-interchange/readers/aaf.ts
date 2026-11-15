/**
 * AAF (`.aaf`) to the neutral model (FL-1552): what Avid Media Composer, Pro Tools, Premiere Pro and
 * DaVinci Resolve export. An AAF file is a compound file (cfb.ts) holding an object tree: each object
 * is a storage with a `properties` stream (pid, stored form, length, then the values); a strong
 * reference names a child storage, and a vector or set of them has an `index` stream beside it.
 *
 * Only the standard AAF property ids (below 0x8000) are used: they are fixed by the specification,
 * while ids above are per file. Objects are recognised by their class id, or by the properties they
 * carry when a vendor subclasses a standard class.
 *
 * A top-level composition becomes a timeline: its picture and sound slots become tracks (timecode,
 * pulldown and edge code slots are left out), its event slot gives markers. A source clip is followed
 * through the master clip to the file's source mob, whose locator names the file. A transition overlaps
 * the clips on either side in AAF; here the clips meet at its cut point, as OpenTimelineIO has them.
 */
import type {
  Clip,
  InterchangeProject,
  Marker,
  MediaReference,
  Stack,
  Timeline,
  Track,
} from 'src/utils/studio-interchange/model.js';
import { CfbEntry, CompoundFile, guidString } from 'src/utils/studio-interchange/readers/cfb.js';
import {
  InterchangeNotice,
  InterchangeReadError,
  Placed,
  PlacedTransition,
  fileNameOf,
  kindFromName,
  placeTracks,
  timeRange,
} from 'src/utils/studio-interchange/readers/common.js';
import { exactRate } from 'src/utils/studio-interchange/readers/otio.js';

const SF_STRONG = 0x22;
const SF_STRONG_VECTOR = 0x32;
const SF_STRONG_SET = 0x3a;
const SF_WEAK = 0x02;
const MAX_OBJECTS = 2_000_000;
const MAX_DEPTH = 64;

/** Standard property ids (AAF object specification). */
const PID = {
  headerContent: 0x3b_03,
  headerDictionary: 0x3b_04,
  headerIdentifications: 0x3b_06,
  productName: 0x3c_02,
  productVersion: 0x3c_04,
  mobs: 0x19_01,
  mobId: 0x44_01,
  mobName: 0x44_02,
  mobSlots: 0x44_03,
  usageCode: 0x44_08,
  slotId: 0x48_01,
  slotName: 0x48_02,
  slotSegment: 0x48_03,
  slotTrackNumber: 0x48_04,
  editRate: 0x4b_01,
  eventEditRate: 0x49_01,
  dataDefinition: 0x02_01,
  length: 0x02_02,
  components: 0x10_01,
  sourceId: 0x11_01,
  sourceSlotId: 0x11_02,
  startTime: 0x12_01,
  cutPoint: 0x18_02,
  transitionGroup: 0x18_01,
  operation: 0x0b_01,
  inputSegments: 0x0b_02,
  nestedSlots: 0x0c_01,
  pulldownInput: 0x0d_01,
  selected: 0x0f_01,
  alternates: 0x0f_02,
  parameters: 0x0b_03,
  parameterDefinition: 0x4c_01,
  constantValue: 0x4d_01,
  pointList: 0x4e_02,
  pointValue: 0x1a_02,
  choices: 0x05_01,
  position: 0x06_01,
  comment: 0x06_02,
  essenceDescription: 0x47_01,
  locators: 0x2f_01,
  url: 0x40_01,
  storedHeight: 0x32_02,
  storedWidth: 0x32_03,
  operationDefinitions: 0x26_03,
  definitionId: 0x1b_01,
  definitionName: 0x1b_02,
  isTimeWarp: 0x1e_02,
} as const;

/** Class ids of the classes told apart by class rather than by their properties. */
const CLASS = {
  compositionMob: '0d010101-0101-3500-060e-2b3402060101',
  masterMob: '0d010101-0101-3600-060e-2b3402060101',
  sourceMob: '0d010101-0101-3700-060e-2b3402060101',
  filler: '0d010101-0101-0900-060e-2b3402060101',
} as const;
const USAGE_TOP_LEVEL = '0d010102-0101-0700-060e-2b3404010101';
/** The Level parameter of an audio gain effect: a linear amplitude. */
const LEVEL_PARAMETER = 'e4962320-2267-11d3-8a4c-0050040ef7d2';
/** Avid's speed map: the playback speed over the clip, 0.5 for half speed. */
const SPEED_MAP_PARAMETER = '8d56827c-847e-11d5-935a-50f857c10000';
/** Effects every Avid sound clip carries; they change nothing Studio shows. */
const QUIET_OPERATIONS = /^(?:Audio Pan|Mono Audio Pan|Stereo Audio Pan)$/;
const PICTURE = new Set([
  '01030202-0100-0000-060e-2b3404010101',
  '6f3c8ce1-6cef-11d2-807d-006008143e6f',
  '05cba732-1daa-11d3-80ad-006008143e6f',
]);
const SOUND = new Set(['01030202-0200-0000-060e-2b3404010101', '78e1ebe1-6cef-11d2-807d-006008143e6f']);

type Property = { form: number; data: Buffer };
type AafObject = { entry: CfbEntry; clsid: string; props: Map<number, Property> };

class AafReader {
  private loaded = 0;
  readonly mobs = new Map<string, AafObject>();
  readonly operations = new Map<string, { name: string; timeWarp: boolean }>();

  constructor(private readonly file: CompoundFile) {}

  load(entry: CfbEntry): AafObject {
    if (++this.loaded > MAX_OBJECTS) {
      throw new InterchangeReadError('too-complex', 'This AAF file has too many objects to read');
    }
    const props = new Map<number, Property>();
    const stream = this.file.children(entry).get('properties');
    if (stream) {
      const data = this.file.read(stream);
      if (data.length >= 4 && data[0] === 0x4c) {
        const count = data.readUInt16LE(2);
        let offset = 4 + count * 6;
        for (let index = 0; index < count && 4 + index * 6 + 6 <= data.length; index++) {
          const at = 4 + index * 6;
          const pid = data.readUInt16LE(at);
          const form = data.readUInt16LE(at + 2);
          const size = data.readUInt16LE(at + 4);
          props.set(pid, { form, data: data.subarray(offset, offset + size) });
          offset += size;
        }
      }
    }
    return { entry, clsid: entry.clsid, props };
  }

  has(object: AafObject | undefined, pid: number) {
    return !!object?.props.has(pid);
  }

  string(object: AafObject | undefined, pid: number) {
    const value = object?.props.get(pid);
    return value ? value.data.toString('utf16le').replace(/\0.*$/s, '') : undefined;
  }

  int(object: AafObject | undefined, pid: number): number | undefined {
    const value = object?.props.get(pid)?.data;
    if (!value) {
      return undefined;
    }
    switch (value.length) {
      case 1: {
        return value[0];
      }
      case 2: {
        return value.readInt16LE(0);
      }
      case 4: {
        return value.readInt32LE(0);
      }
      case 8: {
        return Number(value.readBigInt64LE(0));
      }
      default: {
        return undefined;
      }
    }
  }

  rational(object: AafObject | undefined, pid: number) {
    const value = object?.props.get(pid)?.data;
    return value?.length === 8 ? { num: value.readInt32LE(0), den: value.readInt32LE(4) } : undefined;
  }

  /** A rational stored as an indirect value: byte order, a 16-byte type id, then the value. */
  indirectRational(object: AafObject | undefined, pid: number) {
    const value = object?.props.get(pid)?.data;
    return value?.length === 25 && value[0] === 0x4c
      ? { num: value.readInt32LE(17), den: value.readInt32LE(21) }
      : undefined;
  }

  bytesHex(object: AafObject | undefined, pid: number) {
    return object?.props.get(pid)?.data.toString('hex');
  }

  auid(object: AafObject | undefined, pid: number) {
    const value = object?.props.get(pid);
    if (!value) {
      return;
    }
    if (value.form === SF_WEAK && value.data.length >= 5 + 16) {
      return guidString(value.data.subarray(5, 21));
    }
    return value.data.length === 16 ? guidString(value.data) : undefined;
  }

  strong(object: AafObject | undefined, pid: number) {
    const value = object?.props.get(pid);
    if (!object || value?.form !== SF_STRONG) {
      return;
    }
    const entry = this.file.children(object.entry).get(value.data.toString('utf16le').replace(/\0.*$/s, ''));
    return entry ? this.load(entry) : undefined;
  }

  /** The objects of a strong reference vector or set, in order. */
  many(object: AafObject | undefined, pid: number): AafObject[] {
    const value = object?.props.get(pid);
    if (!object || (value?.form !== SF_STRONG_VECTOR && value?.form !== SF_STRONG_SET)) {
      return [];
    }
    const name = value.data.toString('utf16le').replace(/\0.*$/s, '');
    const siblings = this.file.children(object.entry);
    const index = siblings.get(`${name} index`);
    if (!index) {
      return [];
    }
    const data = this.file.read(index);
    const count = data.length >= 4 ? data.readUInt32LE(0) : 0;
    const keys: number[] = [];
    if (value.form === SF_STRONG_VECTOR) {
      for (let item = 0; item < count && 12 + item * 4 + 4 <= data.length; item++) {
        keys.push(data.readUInt32LE(12 + item * 4));
      }
    } else if (data.length >= 15) {
      const keySize = data[14];
      const step = 8 + keySize;
      for (let item = 0; item < count && 15 + item * step + step <= data.length; item++) {
        keys.push(data.readUInt32LE(15 + item * step));
      }
    }
    return keys.flatMap((key) => {
      const entry = siblings.get(`${name}{${key.toString(16)}}`);
      return entry ? [this.load(entry)] : [];
    });
  }
}

type Context = { aaf: AafReader; fps: number; depth: number; disabled: { count: number } };
type Resolved = { name: string; reference: MediaReference; offset: number };

/** A source clip followed to the file it plays: the master clip's name and the file mob's locator. */
const resolveSource = (
  aaf: AafReader,
  sourceId: string | undefined,
  slotId: number | undefined,
  depth = 0,
): Resolved | null => {
  const mob = sourceId ? aaf.mobs.get(sourceId) : undefined;
  if (!mob || depth > 8) {
    return null;
  }
  const name = aaf.string(mob, PID.mobName)?.trim() || '';
  const descriptor = aaf.strong(mob, PID.essenceDescription);
  const url = aaf
    .many(descriptor, PID.locators)
    .map((locator) => aaf.string(locator, PID.url))
    .find(Boolean);
  if (url) {
    const width = aaf.int(descriptor, PID.storedWidth);
    const height = aaf.int(descriptor, PID.storedHeight);
    const kind = kindFromName(url);
    return {
      name,
      reference: {
        kind: 'external',
        key: url,
        name: fileNameOf(url),
        facts: { ...(kind && { kind }), ...(width && height && { width, height }) },
      },
      offset: 0,
    };
  }
  const slot =
    aaf.many(mob, PID.mobSlots).find((item) => aaf.int(item, PID.slotId) === slotId) ?? aaf.many(mob, PID.mobSlots)[0];
  let segment = aaf.strong(slot, PID.slotSegment);
  if (segment && aaf.has(segment, PID.choices)) {
    segment = aaf.many(segment, PID.choices)[0];
  }
  if (segment && aaf.has(segment, PID.components)) {
    segment = aaf.many(segment, PID.components).find((item) => aaf.has(item, PID.sourceId));
  }
  if (segment && aaf.has(segment, PID.sourceId)) {
    const inner = resolveSource(
      aaf,
      aaf.bytesHex(segment, PID.sourceId),
      aaf.int(segment, PID.sourceSlotId),
      depth + 1,
    );
    if (inner) {
      return {
        name: name || inner.name,
        reference: inner.reference,
        offset: inner.offset + (aaf.int(segment, PID.startTime) ?? 0),
      };
    }
  }
  return { name, reference: { kind: 'missing', name: name || 'Clip' }, offset: 0 };
};

type Built = { placed: Placed[]; transitions: PlacedTransition[]; length: number };

/** A segment of a slot, laid out from `start` in edit units. */
const readSegment = (context: Context, segment: aafObjectOrUndefined, start: number, built: Built): number => {
  const { aaf } = context;
  if (!segment || context.depth > MAX_DEPTH) {
    return start;
  }
  const length = aaf.int(segment, PID.length) ?? 0;
  if (aaf.has(segment, PID.components)) {
    let position = start;
    let previous: Placed | null = null;
    let pendingCut: { start: number; length: number; cut: number; name: string } | null = null;
    for (const component of aaf.many(segment, PID.components)) {
      const componentLength = aaf.int(component, PID.length) ?? 0;
      if (aaf.has(component, PID.cutPoint) || aaf.has(component, PID.transitionGroup)) {
        // A transition overlaps the clips on either side: step back over it.
        position -= componentLength;
        const operation = aaf.operations.get(aaf.auid(aaf.strong(component, PID.transitionGroup), PID.operation) ?? '');
        pendingCut = {
          start: position,
          length: componentLength,
          cut: aaf.int(component, PID.cutPoint) ?? componentLength / 2,
          name: operation?.name.replace(/_\d+$/, '') ?? 'VideoDissolve',
        };
        continue;
      }
      const before = built.placed.length;
      const end = readSegment({ ...context, depth: context.depth + 1 }, component, position, built);
      const added = built.placed.length > before ? built.placed.at(-1)! : null;
      if (pendingCut) {
        const edit = pendingCut.start + pendingCut.cut;
        // The clip before ends at the cut; the clip after starts there, later in its media.
        if (previous?.item.type === 'clip' && previous.start + previous.duration > edit) {
          previous.duration = Math.max(0, edit - previous.start);
          previous.item.sourceRange = {
            ...previous.item.sourceRange!,
            duration: { value: previous.duration, rate: context.fps },
          };
        }
        if (added?.item.type === 'clip' && added.start < edit) {
          const trim = edit - added.start;
          added.start = edit;
          added.duration = Math.max(0, added.duration - trim);
          const range = added.item.sourceRange!;
          added.item.sourceRange = {
            startTime: {
              value: range.startTime.value + trim * (range.startTime.rate / context.fps),
              rate: range.startTime.rate,
            },
            duration: { value: added.duration, rate: context.fps },
          };
        }
        built.transitions.push({ name: pendingCut.name, start: pendingCut.start, duration: pendingCut.length, edit });
        pendingCut = null;
      }
      previous = added ?? null;
      position = end;
    }
    return Math.max(position, start + length);
  }
  if (aaf.has(segment, PID.sourceId)) {
    const resolved = resolveSource(aaf, aaf.bytesHex(segment, PID.sourceId), aaf.int(segment, PID.sourceSlotId));
    if (length > 0) {
      const sourceStart = (aaf.int(segment, PID.startTime) ?? 0) + (resolved?.offset ?? 0);
      const reference: MediaReference = resolved?.reference ?? { kind: 'missing', name: 'Clip' };
      const name = resolved?.name || (reference.kind === 'external' ? reference.name : reference.name) || 'Clip';
      const clip: Clip = {
        type: 'clip',
        name,
        sourceRange: {
          startTime: { value: sourceStart, rate: context.fps },
          duration: { value: length, rate: context.fps },
        },
        mediaReference: reference,
      };
      const fadeIn = aaf.int(segment, PID.fadeInLength) ?? 0;
      const fadeOut = aaf.int(segment, PID.fadeOutLength) ?? 0;
      if (fadeIn > 0 || fadeOut > 0) {
        clip.frameleaf = {
          ...(fadeIn > 0 && { fadeInSeconds: fadeIn / context.fps }),
          ...(fadeOut > 0 && { fadeOutSeconds: fadeOut / context.fps }),
        };
      }
      built.placed.push({ start, duration: length, item: clip });
    }
    return start + length;
  }
  if (aaf.has(segment, PID.operation)) {
    const operation = aaf.operations.get(aaf.auid(segment, PID.operation) ?? '');
    const input = aaf.many(segment, PID.inputSegments)[0];
    const before = built.placed.length;
    if (operation?.timeWarp) {
      const inputLength = aaf.int(input, PID.length) ?? length;
      const speeds = aaf
        .many(
          aaf
            .many(segment, PID.parameters)
            .find((item) => aaf.auid(item, PID.parameterDefinition) === SPEED_MAP_PARAMETER),
          PID.pointList,
        )
        .map((point) => aaf.indirectRational(point, PID.pointValue))
        .filter((value): value is { num: number; den: number } => !!value && value.den !== 0)
        .map((value) => value.num / value.den);
      const ramp = speeds.some((value) => Math.abs(value - speeds[0]) > 1e-3);
      const inner: Built = { placed: [], transitions: [], length: 0 };
      readSegment({ ...context, depth: context.depth + 1 }, input, start, inner);
      for (const entry of inner.placed) {
        const speed =
          speeds.length > 0
            ? speeds.reduce((sum, value) => sum + value, 0) / speeds.length
            : length > 0
              ? inputLength / length
              : 1;
        entry.duration = length;
        if (entry.item.type === 'clip') {
          entry.item.sourceRange = { ...entry.item.sourceRange, duration: { value: length, rate: context.fps } };
          entry.item.frameleaf = {
            ...entry.item.frameleaf,
            ...(Math.abs(speed - 1) > 1e-3 && { speed: Math.round(speed * 1000) / 1000 }),
            ...(ramp && { speedRamp: true }),
          };
        }
        built.placed.push(entry);
      }
      return start + length;
    }
    readSegment({ ...context, depth: context.depth + 1 }, input, start, built);
    const name = operation?.name.replace(/_\d+$/, '') ?? '';
    const level = /Audio Gain/.test(name)
      ? aaf.many(segment, PID.parameters).find((item) => aaf.auid(item, PID.parameterDefinition) === LEVEL_PARAMETER)
      : undefined;
    const amplitude = aaf.rational(level, PID.constantValue);
    for (const entry of built.placed.slice(before)) {
      if (entry.item.type !== 'clip' || !name || QUIET_OPERATIONS.test(name)) {
        continue;
      }
      if (/Audio Gain/.test(name)) {
        if (amplitude && amplitude.den > 0 && amplitude.num > 0 && amplitude.num !== amplitude.den) {
          entry.item.frameleaf = {
            ...entry.item.frameleaf,
            volumeDb: Math.round(20 * Math.log10(amplitude.num / amplitude.den) * 100) / 100,
          };
        }
        continue;
      }
      entry.item.frameleaf = {
        ...entry.item.frameleaf,
        effects: [...(entry.item.frameleaf?.effects ?? []), { name }],
      };
    }
    return start + Math.max(length, 0);
  }
  if (aaf.has(segment, PID.nestedSlots)) {
    const slots = aaf.many(segment, PID.nestedSlots);
    if (slots.length === 1) {
      return readSegment({ ...context, depth: context.depth + 1 }, slots[0], start, built);
    }
    // Layers of picture: a nest of its own tracks, the later ones on top.
    const tracks = slots.flatMap((slot, index) => {
      const inner: Built = { placed: [], transitions: [], length: 0 };
      readSegment({ ...context, depth: context.depth + 1 }, slot, 0, inner);
      return inner.placed.length > 0
        ? placeTracks(
            'video',
            `V${index + 1}`,
            toSeconds(inner.placed, context.fps),
            toSecondsTransitions(inner.transitions, context.fps),
            context.fps,
          )
        : [];
    });
    if (tracks.length > 0 && length > 0) {
      const stack: Stack = {
        type: 'stack',
        name: 'Nest',
        tracks,
        sourceRange: timeRange(0, length / context.fps, context.fps),
      };
      built.placed.push({ start, duration: length, item: stack });
    }
    return start + length;
  }
  if (aaf.has(segment, PID.selected)) {
    const selected = aaf.strong(segment, PID.selected);
    // A clip switched off in Avid: the selector shows filler or a scope reference, and keeps the clip
    // as an alternate.
    const plays = [PID.sourceId, PID.components, PID.operation, PID.nestedSlots].some((pid) => aaf.has(selected, pid));
    if (!plays && aaf.many(segment, PID.alternates).length > 0) {
      context.disabled.count++;
      return start + length;
    }
    return readSegment({ ...context, depth: context.depth + 1 }, selected, start, built);
  }
  if (aaf.has(segment, PID.choices)) {
    return readSegment({ ...context, depth: context.depth + 1 }, aaf.many(segment, PID.choices)[0], start, built);
  }
  if (aaf.has(segment, PID.pulldownInput)) {
    return readSegment({ ...context, depth: context.depth + 1 }, aaf.strong(segment, PID.pulldownInput), start, built);
  }
  // Filler, scope references and anything this release does not read keep their length.
  return start + length;
};
type aafObjectOrUndefined = AafObject | undefined;

/** Edit units to seconds for the shared track builder. */
const toSeconds = (placed: Placed[], fps: number): Placed[] =>
  placed
    .filter((entry) => entry.duration > 0)
    .map((entry) => ({ ...entry, start: entry.start / fps, duration: entry.duration / fps }));
const toSecondsTransitions = (transitions: PlacedTransition[], fps: number): PlacedTransition[] =>
  transitions.map((item) => ({
    name: item.name,
    start: item.start / fps,
    duration: item.duration / fps,
    ...(item.edit !== undefined && { edit: item.edit / fps }),
  }));

export const readAaf = (bytes: Buffer): InterchangeProject => {
  const file = new CompoundFile(bytes);
  const aaf = new AafReader(file);
  const headerEntry = file
    .children(file.root)
    .values()
    .find((entry) => entry.name.startsWith('Header'));
  if (!headerEntry) {
    throw new InterchangeReadError('unsupported', 'This compound file is not an AAF project');
  }
  const header = aaf.load(headerEntry);
  for (const definition of aaf.many(aaf.strong(header, PID.headerDictionary), PID.operationDefinitions)) {
    const id = aaf.auid(definition, PID.definitionId);
    if (id) {
      aaf.operations.set(id, {
        name: aaf.string(definition, PID.definitionName) ?? '',
        timeWarp: aaf.int(definition, PID.isTimeWarp) === 1,
      });
    }
  }
  const mobs = aaf.many(aaf.strong(header, PID.headerContent), PID.mobs);
  for (const mob of mobs) {
    const id = aaf.bytesHex(mob, PID.mobId);
    if (id) {
      aaf.mobs.set(id, mob);
    }
  }
  const compositions = mobs.filter((mob) => mob.clsid === CLASS.compositionMob);
  const topLevel = compositions.filter((mob) => aaf.auid(mob, PID.usageCode) === USAGE_TOP_LEVEL);
  const chosen = topLevel.length > 0 ? topLevel : compositions;
  const disabled = { count: 0 };
  const timelines: Timeline[] = chosen.flatMap((mob) => {
    const slots = aaf.many(mob, PID.mobSlots);
    const timelineSlots = slots.filter((slot) => aaf.has(slot, PID.editRate));
    const firstRate = timelineSlots
      .map((slot) => aaf.rational(slot, PID.editRate))
      .find((rate) => rate && rate.den > 0);
    const fps = firstRate ? firstRate.num / firstRate.den : 25;
    const tracks: Track[] = [];
    for (const slot of timelineSlots.toSorted(
      (a, b) => (aaf.int(a, PID.slotTrackNumber) ?? 0) - (aaf.int(b, PID.slotTrackNumber) ?? 0),
    )) {
      const segment = aaf.strong(slot, PID.slotSegment);
      const definition = aaf.auid(segment, PID.dataDefinition);
      const kind =
        definition && PICTURE.has(definition) ? 'video' : definition && SOUND.has(definition) ? 'audio' : null;
      if (!kind) {
        continue;
      }
      const rate = aaf.rational(slot, PID.editRate);
      const slotFps = rate && rate.den > 0 ? rate.num / rate.den : fps;
      const label = `${kind === 'video' ? 'V' : 'A'}${aaf.int(slot, PID.slotTrackNumber) ?? tracks.length + 1}`;
      // Avid keeps stacked video layers as one nested scope per slot: each layer becomes a track.
      const layers = aaf.has(segment, PID.nestedSlots) ? aaf.many(segment, PID.nestedSlots) : [segment];
      for (const [index, layer] of layers.entries()) {
        const built: Built = { placed: [], transitions: [], length: 0 };
        readSegment({ aaf, fps: slotFps, depth: 0, disabled }, layer, 0, built);
        if (built.placed.length === 0) {
          continue;
        }
        const name = aaf.string(slot, PID.slotName)?.trim() || label;
        tracks.push(
          ...placeTracks(
            kind,
            layers.length > 1 ? `${name} ${index + 1}` : name,
            toSeconds(built.placed, slotFps),
            toSecondsTransitions(built.transitions, slotFps),
            slotFps,
          ),
        );
      }
    }
    const markers: Marker[] = slots
      .filter((slot) => aaf.has(slot, PID.eventEditRate))
      .flatMap((slot) => {
        const rate = aaf.rational(slot, PID.eventEditRate);
        const slotFps = rate && rate.den > 0 ? rate.num / rate.den : fps;
        const segment = aaf.strong(slot, PID.slotSegment);
        const events = aaf.has(segment, PID.components) ? aaf.many(segment, PID.components) : segment ? [segment] : [];
        return events
          .filter((event) => aaf.has(event, PID.position))
          .map((event) => {
            const comment = aaf.string(event, PID.comment)?.trim() ?? '';
            return {
              name: comment.slice(0, 200) || 'Marker',
              markedRange: timeRange((aaf.int(event, PID.position) ?? 0) / slotFps, 0, slotFps),
            };
          });
      });
    // AAF has no canvas of its own: the first picture file's size stands in.
    const facts = tracks
      .filter((track) => track.kind === 'video')
      .flatMap((track) => track.children)
      .flatMap((item) =>
        item.type === 'clip' && item.mediaReference.kind === 'external' ? [item.mediaReference.facts] : [],
      )
      .find((item) => item?.width && item.height);
    return [
      {
        name: aaf.string(mob, PID.mobName)?.trim() || 'Sequence',
        rate: exactRate(Math.round(fps * 1000) / 1000),
        canvas: { width: facts?.width ?? 1920, height: facts?.height ?? 1080 },
        tracks,
        ...(markers.length > 0 && { markers }),
      },
    ];
  });
  if (timelines.length === 0) {
    throw new InterchangeReadError('empty', 'This AAF file has no sequence in it');
  }
  const identification = aaf.many(header, PID.headerIdentifications).at(-1);
  const product = aaf.string(identification, PID.productName);
  const version = aaf.string(identification, PID.productVersion);
  const notices: InterchangeNotice[] = [];
  if (disabled.count > 0) {
    notices.push({
      code: 'clips-disabled',
      subject: String(disabled.count),
      what: `${disabled.count} ${disabled.count === 1 ? 'clip' : 'clips'} switched off in the other editor`,
      became: 'Left out; the space each took is kept',
    });
  }
  return {
    source: 'aaf',
    ...((product || version) && { sourceVersion: [product, version].filter(Boolean).join(' ') }),
    timelines,
    ...(notices.length > 0 && { notices }),
  };
};
