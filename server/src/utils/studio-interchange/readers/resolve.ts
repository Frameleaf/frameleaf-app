/**
 * DaVinci Resolve project (`.drp`) and timeline (`.drt`) exports to the neutral model (FL-1551). Both
 * are ZIP archives of XML: `MediaPool/…/MpFolder.xml` lists the timelines (`Sm2Timeline`, with its
 * `Sm2Sequence`: frame rate, resolution, and where the timeline starts), and each
 * `SeqContainer/<id>.xml` holds a sequence's tracks (`Sm2TiTrack`) and their items: video and audio
 * clips and transitions. A `.drt` is the same without `project.xml`.
 *
 * Numbers are as Resolve writes them: frames at the timeline's rate, sometimes as `frame|hex double`;
 * rates and extents are little-endian doubles in hex; the resolution is two big-endian integers. A
 * clip's place includes the timeline's start timecode, which is taken off.
 *
 * Volume, fades, effects, speed and markers live in binary blobs whose layout Blackmagic does not
 * publish; a clip that has them is named in the report rather than silently changed.
 */
import type { Clip, InterchangeProject, Timeline, Track } from 'src/utils/studio-interchange/model.js';
import { ZipByteSource, ZipEntry, readZipDirectory, readZipEntry } from 'src/utils/studio-bundle.js';
import {
  InterchangeNotice,
  InterchangeReadError,
  Placed,
  PlacedTransition,
  fileNameOf,
  kindFromName,
  placeTracks,
  timeRange,
  versionNotice,
} from 'src/utils/studio-interchange/readers/common.js';
import { exactRate } from 'src/utils/studio-interchange/readers/otio.js';
import { INTERCHANGE_ZIP_LIMITS, MAX_DOCUMENT_BYTES } from 'src/utils/studio-interchange/readers/zip-limits.js';
import { XmlNode, child, childText, children, descendants, parseXml } from 'src/utils/studio-interchange/xml.js';

/** Resolve's project database versions the reader was written against (Resolve 19 to 21). */
const TESTED_VERSIONS = ['14', '15', '16', '17'];
const MAX_XML_BYTES = MAX_DOCUMENT_BYTES;

/** A little-endian double from the first 16 hex digits. */
export const resolveDouble = (hex: string | undefined) => {
  const clean = hex?.trim() ?? '';
  return /^[\da-f]{16}/i.test(clean) ? Buffer.from(clean.slice(0, 16), 'hex').readDoubleLE(0) : undefined;
};

/** A frame count: `123`, or `123|<hex double>` where the double is the exact value. */
export const resolveFrames = (value: string | undefined) => {
  const text = value?.trim();
  if (!text) {
    return 0;
  }
  const [whole, exact] = text.split('|', 2);
  const precise = resolveDouble(exact);
  return precise !== undefined && Number.isFinite(precise) ? precise : Number(whole) || 0;
};

type Sequence = { id: string; name: string; fps: number; width: number; height: number; startSeconds: number };

const sequencesOf = (folders: XmlNode[]): Sequence[] =>
  folders.flatMap((folder) =>
    descendants(folder, 'Sm2Timeline').flatMap((timeline) => {
      const sequence = descendants(timeline, 'Sm2Sequence')[0];
      const id = sequence?.attributes.DbId;
      if (!id) {
        return [];
      }
      const fps = resolveDouble(childText(sequence, 'FrameRate')) ?? 24;
      const resolution = childText(sequence, 'Resolution') ?? '';
      const width = /^[\da-f]{32}$/i.test(resolution)
        ? Number(Buffer.from(resolution.slice(0, 16), 'hex').readBigUInt64BE())
        : 0;
      const height = /^[\da-f]{32}$/i.test(resolution)
        ? Number(Buffer.from(resolution.slice(16), 'hex').readBigUInt64BE())
        : 0;
      return [
        {
          id,
          name: childText(timeline, 'Name') ?? 'Timeline',
          fps: fps > 0 && fps <= 240 ? fps : 24,
          width: width > 0 && width < 100_000 ? width : 1920,
          height: height > 0 && height < 100_000 ? height : 1080,
          startSeconds: resolveDouble(childText(sequence, 'MediaExtents')) ?? 0,
        },
      ];
    }),
  );

type Context = { fps: number; origin: number; markers: { count: number } };

const ALIGNMENT_EDIT = (alignment: string | undefined, start: number, duration: number) =>
  alignment === '1' ? start : alignment === '3' ? start + duration : start + duration / 2;

const trackOf = (context: Context, track: XmlNode, kind: Track['kind'], index: number): Track[] => {
  const placed: Placed[] = [];
  const transitions: PlacedTransition[] = [];
  for (const element of children(child(track, 'Items'), 'Element')) {
    for (const item of element.children) {
      const start = (resolveFrames(childText(item, 'Start')) - context.origin) / context.fps;
      const duration = resolveFrames(childText(item, 'Duration')) / context.fps;
      if (!(duration > 0)) {
        continue;
      }
      if (item.name === 'Sm2TiTransition') {
        transitions.push({
          name: childText(item, 'PrettyType') ?? childText(item, 'Name') ?? 'Cross Dissolve',
          start,
          duration,
          edit: ALIGNMENT_EDIT(childText(item, 'AlignmentType'), start, duration),
        });
        continue;
      }
      if (!/^Sm2Ti\w*Clip$/.test(item.name)) {
        continue;
      }
      if (childText(item, 'MarkersBA')) {
        context.markers.count++;
      }
      const path = childText(item, 'MediaFilePath');
      const name = childText(item, 'Name') ?? (path ? fileNameOf(path) : 'Clip');
      const sourceRate = resolveDouble(childText(item, 'MediaFrameRate'));
      const blobs = !!childText(item, 'EffectFiltersBA');
      const clip: Clip = {
        type: 'clip',
        name,
        sourceRange: timeRange(
          resolveFrames(childText(item, 'In')) / context.fps,
          duration,
          sourceRate && sourceRate > 0 ? sourceRate : context.fps,
        ),
        mediaReference: path
          ? {
              kind: 'external',
              key: path,
              name: fileNameOf(path),
              ...(kindFromName(path) && { facts: { kind: kindFromName(path) } }),
            }
          : item.name === 'Sm2TiVideoClip'
            ? { kind: 'generator', generator: 'other', name }
            : { kind: 'missing', name },
        ...(blobs && { frameleaf: { effects: [{ name: 'Volume, fades or effects set in Resolve' }] } }),
      };
      placed.push({ start, duration, item: clip });
    }
  }
  const name = childText(track, 'UserDefinedName') ?? `${kind === 'video' ? 'V' : 'A'}${index + 1}`;
  return placed.length > 0 ? placeTracks(kind, name, placed, transitions, context.fps) : [];
};

const readXmlEntry = async (source: ZipByteSource, entry: ZipEntry) =>
  parseXml(await readZipEntry(source, entry, MAX_XML_BYTES), {
    maxBytes: MAX_XML_BYTES,
    maxDepth: 256,
    maxElements: 4_000_000,
  });

export const readResolve = async (source: ZipByteSource): Promise<InterchangeProject> => {
  let directory;
  try {
    directory = await readZipDirectory(source, INTERCHANGE_ZIP_LIMITS);
  } catch {
    throw new InterchangeReadError('malformed', 'This DaVinci Resolve file could not be opened');
  }
  const folders: XmlNode[] = [];
  const containers: XmlNode[] = [];
  let version: string | undefined;
  let timelineMarkerBlobs = 0;
  for (const entry of directory.entries) {
    if (entry.name === 'project.xml') {
      // Timeline markers sit in project.xml as binary blobs: counted so the report can say so.
      const text = (await readZipEntry(source, entry, MAX_XML_BYTES)).toString('utf8');
      timelineMarkerBlobs = text.match(/<Sm2SequenceLockableBlob\b/g)?.length ?? 0;
      continue;
    }
    if (/(^|\/)MpFolder\.xml$/i.test(entry.name)) {
      folders.push(await readXmlEntry(source, entry));
    } else if (/(^|\/)SeqContainer[^/]*(\/[^/]+)?\.xml$/i.test(entry.name)) {
      const head = (await readZipEntry(source, entry, MAX_XML_BYTES)).subarray(0, 512).toString('utf8');
      version ??= head.match(/DbPrjVer="(\d+)"/)?.[1];
      containers.push(await readXmlEntry(source, entry));
    }
  }
  const sequences = sequencesOf(folders);
  if (containers.length === 0 || sequences.length === 0) {
    throw new InterchangeReadError('empty', 'This DaVinci Resolve file has no timeline in it');
  }
  const markers = { count: 0 };
  const timelines: Timeline[] = sequences.flatMap((sequence) => {
    const context: Context = { fps: sequence.fps, origin: sequence.startSeconds * sequence.fps, markers };
    const belongs = (track: XmlNode) => childText(track, 'Sequence') === sequence.id;
    const tracks: Track[] = [];
    for (const container of containers) {
      for (const [kind, vector] of [
        ['video', 'VideoTrackVec'],
        ['audio', 'AudioTrackVec'],
      ] as const) {
        const list = children(child(container, vector), 'Element')
          .map((element) => child(element, 'Sm2TiTrack'))
          .filter((track): track is XmlNode => !!track && belongs(track));
        for (const [index, track] of list.entries()) {
          tracks.push(...trackOf(context, track, kind, index));
        }
      }
    }
    return tracks.length > 0
      ? [
          {
            name: sequence.name,
            rate: exactRate(Math.round(sequence.fps * 1000) / 1000),
            canvas: { width: sequence.width, height: sequence.height },
            tracks,
          },
        ]
      : [];
  });
  if (timelines.length === 0) {
    throw new InterchangeReadError('empty', 'This DaVinci Resolve file has no clips on its timelines');
  }
  const notices: InterchangeNotice[] = versionNotice('DaVinci Resolve project', version, TESTED_VERSIONS);
  if (timelineMarkerBlobs > 0) {
    notices.push({
      code: 'items-unknown',
      subject: String(timelineMarkerBlobs),
      what: 'Timeline markers',
      became: 'Left out: Resolve stores markers in a form Frameleaf does not read yet',
    });
  }
  if (markers.count > 0) {
    notices.push({
      code: 'items-unknown',
      subject: String(markers.count),
      what: `Markers on ${markers.count} ${markers.count === 1 ? 'clip' : 'clips'}`,
      became: 'Left out: Resolve stores markers in a form Frameleaf does not read yet',
    });
  }
  return {
    source: 'resolve',
    ...(version && { sourceVersion: version }),
    timelines,
    ...(notices.length > 0 && { notices }),
  };
};
