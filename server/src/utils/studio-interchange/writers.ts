/**
 * The neutral timeline to another editor's file (FL-1566): OpenTimelineIO, Final Cut Pro XML (1.10),
 * Final Cut Pro 7 XML and a CMX 3600 edit decision list. Each writer is the matching reader run the
 * other way, so a written file reads back to the same clips. `sendBackReport` says, per target, what
 * that kind of file cannot carry, naming the clips.
 *
 * Files are named by their file name alone: the other editor relinks them on its own disk.
 */
import type { Clip, Marker, Stack, Timeline, Track, TrackChild } from 'src/utils/studio-interchange/model.js';
import { seconds } from 'src/utils/studio-interchange/model.js';

export type SendBackFormat = 'otio' | 'fcpxml' | 'fcp7' | 'edl';
export type SendBackNote = {
  code: 'effects' | 'titles' | 'upper-tracks' | 'picture-moves' | 'nests' | 'grades';
  clips: string[];
};

const escape = (value: string) =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const length = (child: TrackChild) =>
  child.type === 'transition' ? 0 : child.sourceRange ? seconds(child.sourceRange.duration) : 0;
const fileUrl = (key: string) => (/^[a-z]+:\/\//i.test(key) ? key : encodeURI(key));

/* ---------------------------------------------------------------- OpenTimelineIO */

const otioTime = (value: number, rate: number) => ({
  OTIO_SCHEMA: 'RationalTime.1',
  rate,
  value: Math.round(value * rate * 1e6) / 1e6,
});
const otioRange = (start: number, duration: number, rate: number) => ({
  OTIO_SCHEMA: 'TimeRange.1',
  start_time: otioTime(start, rate),
  duration: otioTime(duration, rate),
});
const otioMarkers = (markers: Marker[] | undefined, rate: number) =>
  (markers ?? []).map((marker) => ({
    OTIO_SCHEMA: 'Marker.2',
    name: marker.name,
    color: marker.color && !marker.color.startsWith('#') ? marker.color : 'GREEN',
    comment: marker.note ?? '',
    marked_range: otioRange(seconds(marker.markedRange.startTime), seconds(marker.markedRange.duration), rate),
    metadata: {},
  }));

const otioChild = (child: TrackChild, rate: number): Record<string, unknown> => {
  switch (child.type) {
    case 'gap': {
      return {
        OTIO_SCHEMA: 'Gap.1',
        name: '',
        source_range: otioRange(0, seconds(child.sourceRange.duration), rate),
        metadata: {},
      };
    }
    case 'transition': {
      return {
        OTIO_SCHEMA: 'Transition.1',
        name: child.name,
        transition_type: child.name === 'SMPTE_Dissolve' ? 'SMPTE_Dissolve' : 'Custom_Transition',
        in_offset: otioTime(seconds(child.inOffset), rate),
        out_offset: otioTime(seconds(child.outOffset), rate),
        metadata: {},
      };
    }
    case 'stack': {
      return {
        OTIO_SCHEMA: 'Stack.1',
        name: child.name,
        source_range: child.sourceRange
          ? otioRange(seconds(child.sourceRange.startTime), seconds(child.sourceRange.duration), rate)
          : null,
        children: child.tracks.map((track) => otioTrack(track, rate)),
        markers: otioMarkers(child.markers, rate),
        metadata: {},
      };
    }
    default: {
      const reference = child.mediaReference;
      const media =
        reference.kind === 'external'
          ? {
              OTIO_SCHEMA: 'ExternalReference.1',
              name: reference.name,
              target_url: fileUrl(reference.key),
              available_range: null,
              metadata: {},
            }
          : reference.kind === 'generator'
            ? {
                OTIO_SCHEMA: 'GeneratorReference.1',
                name: reference.name,
                generator_kind:
                  reference.generator === 'title'
                    ? 'TextGenerator'
                    : reference.generator === 'solid'
                      ? 'SolidColor'
                      : 'Generator',
                parameters: {},
                metadata: {},
              }
            : { OTIO_SCHEMA: 'MissingReference.1', name: reference.name, metadata: {} };
      const speed = child.frameleaf?.speed;
      return {
        OTIO_SCHEMA: 'Clip.2',
        name: child.name,
        source_range: otioRange(seconds(child.sourceRange.startTime), seconds(child.sourceRange.duration), rate),
        media_references: { DEFAULT_MEDIA: media },
        active_media_reference_key: 'DEFAULT_MEDIA',
        effects:
          speed !== undefined && speed !== 1
            ? [
                {
                  OTIO_SCHEMA: 'LinearTimeWarp.1',
                  name: '',
                  effect_name: 'LinearTimeWarp',
                  time_scalar: speed,
                  metadata: {},
                },
              ]
            : [],
        markers: otioMarkers(child.markers, rate),
        enabled: true,
        // What only Frameleaf reads back: the title's look, levels, fades.
        metadata: child.frameleaf ? { frameleaf: { ...child.frameleaf, speed: undefined } } : {},
      };
    }
  }
};

const otioTrack = (track: Track, rate: number) => ({
  OTIO_SCHEMA: 'Track.1',
  name: track.name,
  kind: track.kind === 'audio' ? 'Audio' : 'Video',
  enabled: !track.muted,
  children: track.children.map((child) => otioChild(child, rate)),
  markers: [],
  metadata: {},
});

export const writeOtio = (timeline: Timeline) => {
  const rate = timeline.rate.num / timeline.rate.den;
  return `${JSON.stringify(
    {
      OTIO_SCHEMA: 'Timeline.1',
      name: timeline.name,
      global_start_time: otioTime(0, rate),
      tracks: {
        OTIO_SCHEMA: 'Stack.1',
        name: 'tracks',
        children: timeline.tracks.map((track) => otioTrack(track, rate)),
        markers: otioMarkers(timeline.markers, rate),
        metadata: {},
      },
      metadata: { frameleaf: { canvas: timeline.canvas } },
    },
    (_key, value) => (value === undefined ? undefined : value),
    2,
  )}\n`;
};

/* ---------------------------------------------------------------- Final Cut Pro 7 XML */

type Fcp7Context = { timebase: number; ntsc: boolean; fps: number; files: Map<string, string>; nextId: () => number };
const fcp7Rate = (context: Fcp7Context) =>
  `<rate><timebase>${context.timebase}</timebase><ntsc>${context.ntsc ? 'TRUE' : 'FALSE'}</ntsc></rate>`;
const frames = (secondsValue: number, fps: number) => Math.round(secondsValue * fps);

const fcp7File = (context: Fcp7Context, clip: Clip) => {
  const reference = clip.mediaReference;
  if (reference.kind !== 'external') {
    return '';
  }
  const known = context.files.get(reference.key);
  if (known) {
    return `<file id="${known}"/>`;
  }
  const id = `file-${context.nextId()}`;
  context.files.set(reference.key, id);
  const path = /^file:\/\//i.test(reference.key)
    ? reference.key
    : `file://localhost/${encodeURI(reference.key.replace(/^\/+/, ''))}`;
  return `<file id="${id}"><name>${escape(reference.name)}</name><pathurl>${escape(path)}</pathurl>${fcp7Rate(context)}</file>`;
};

const fcp7Track = (context: Fcp7Context, track: Track) => {
  let position = 0;
  const parts: string[] = [];
  for (const [index, child] of track.children.entries()) {
    if (child.type === 'transition') {
      const start = frames(position - seconds(child.inOffset), context.fps);
      const end = frames(position + seconds(child.outOffset), context.fps);
      parts.push(
        `<transitionitem><start>${start}</start><end>${end}</end><alignment>center</alignment>${fcp7Rate(context)}<effect><name>Cross Dissolve</name><effectid>Cross Dissolve</effectid><effecttype>transition</effecttype><mediatype>${track.kind}</mediatype></effect></transitionitem>`,
      );
      continue;
    }
    const duration = length(child);
    const start = frames(position, context.fps);
    const end = frames(position + duration, context.fps);
    position += duration;
    if (child.type === 'gap') {
      continue;
    }
    const id = `${track.kind === 'audio' ? 'a' : 'v'}clip-${context.nextId()}-${index}`;
    if (child.type === 'stack') {
      parts.push(
        `<clipitem id="${id}"><name>${escape(child.name)}</name><start>${start}</start><end>${end}</end><in>0</in><out>${end - start}</out>${fcp7Sequence(context, child.name, child.tracks, undefined)}</clipitem>`,
      );
      continue;
    }
    if (child.mediaReference.kind === 'generator' && child.mediaReference.generator === 'title') {
      const title = child.frameleaf?.title;
      parts.push(
        `<generatoritem id="${id}"><name>${escape(child.name)}</name><start>${start}</start><end>${end}</end><in>0</in><out>${end - start}</out>${fcp7Rate(context)}<effect><name>Text</name><effectid>Text</effectid><effectcategory>Text</effectcategory><effecttype>generator</effecttype><mediatype>video</mediatype><parameter><parameterid>str</parameterid><name>Text</name><value>${escape(title?.text ?? child.name)}</value></parameter>${title?.font ? `<parameter><parameterid>font</parameterid><name>Font</name><value>${escape(title.font)}</value></parameter>` : ''}</effect></generatoritem>`,
      );
      continue;
    }
    const speed = Math.abs(child.frameleaf?.speed ?? 1) || 1;
    const sourceIn = frames(seconds(child.sourceRange.startTime), context.fps);
    const sourceOut = sourceIn + Math.round((end - start) * speed);
    const level =
      track.kind === 'audio' && child.frameleaf?.volumeDb
        ? `<filter><effect><name>Audio Levels</name><effectid>audiolevels</effectid><effecttype>audiolevels</effecttype><mediatype>audio</mediatype><parameter><parameterid>level</parameterid><value>${(10 ** (child.frameleaf.volumeDb / 20)).toFixed(4)}</value></parameter></effect></filter>`
        : '';
    const remap =
      speed !== 1 || (child.frameleaf?.speed ?? 1) < 0
        ? `<filter><effect><name>Time Remap</name><effectid>timeremap</effectid><effecttype>motion</effecttype><mediatype>video</mediatype><parameter><parameterid>speed</parameterid><value>${Math.round(speed * 100)}</value></parameter><parameter><parameterid>reverse</parameterid><value>${(child.frameleaf?.speed ?? 1) < 0 ? 'TRUE' : 'FALSE'}</value></parameter></effect></filter>`
        : '';
    parts.push(
      `<clipitem id="${id}"><name>${escape(child.name)}</name>${fcp7Rate(context)}<start>${start}</start><end>${end}</end><in>${sourceIn}</in><out>${sourceOut}</out>${fcp7File(context, child)}${level}${remap}</clipitem>`,
    );
  }
  return `<track>${parts.join('')}</track>`;
};

const fcp7Sequence = (
  context: Fcp7Context,
  name: string,
  tracks: Track[],
  canvas: Timeline['canvas'] | undefined,
  markers?: Marker[],
) => {
  const video = tracks.filter((track) => track.kind === 'video').map((track) => fcp7Track(context, track));
  const audio = tracks.filter((track) => track.kind === 'audio').map((track) => fcp7Track(context, track));
  const markerXml = (markers ?? [])
    .map((marker) => {
      const start = frames(seconds(marker.markedRange.startTime), context.fps);
      const span = frames(seconds(marker.markedRange.duration), context.fps);
      return `<marker><name>${escape(marker.name)}</name><comment>${escape(marker.note ?? '')}</comment><in>${start}</in><out>${span > 0 ? start + span : -1}</out></marker>`;
    })
    .join('');
  const format = canvas
    ? `<format><samplecharacteristics><width>${canvas.width}</width><height>${canvas.height}</height></samplecharacteristics></format>`
    : '';
  return `<sequence id="sequence-${context.nextId()}"><name>${escape(name)}</name>${fcp7Rate(context)}${markerXml}<media><video>${format}${video.join('')}</video><audio>${audio.join('')}</audio></media></sequence>`;
};

export const writeFcp7Xml = (timeline: Timeline) => {
  const fps = timeline.rate.num / timeline.rate.den;
  let counter = 1;
  const context: Fcp7Context = {
    timebase: Math.round(fps),
    ntsc: timeline.rate.den === 1001,
    fps,
    files: new Map(),
    nextId: () => counter++,
  };
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n<xmeml version="5">${fcp7Sequence(context, timeline.name, timeline.tracks, timeline.canvas, timeline.markers)}</xmeml>\n`;
};

/* ---------------------------------------------------------------- Final Cut Pro XML */

export const writeFcpxml = (timeline: Timeline) => {
  const { num, den } = timeline.rate;
  const fps = num / den;
  const time = (value: number) => `${Math.round(value * fps) * den}/${num}s`;
  const assets = new Map<string, { id: string; name: string; key: string; audioOnly: boolean; end: number }>();
  let counter = 3;
  const assetFor = (clip: Clip) => {
    const reference = clip.mediaReference;
    if (reference.kind !== 'external') {
      return;
    }
    let asset = assets.get(reference.key);
    if (!asset) {
      asset = {
        id: `r${counter++}`,
        name: reference.name,
        key: reference.key,
        audioOnly: reference.facts?.kind === 'audio',
        end: 0,
      };
      assets.set(reference.key, asset);
    }
    const speed = Math.abs(clip.frameleaf?.speed ?? 1) || 1;
    asset.end = Math.max(asset.end, seconds(clip.sourceRange.startTime) + seconds(clip.sourceRange.duration) * speed);
    return asset;
  };
  const storyline = (track: Track, lane: number): string => {
    let position = 0;
    const parts: string[] = [];
    for (const child of track.children) {
      if (child.type === 'transition') {
        const total = seconds(child.inOffset) + seconds(child.outOffset);
        parts.push(
          `<transition name="Cross Dissolve" offset="${time(position - seconds(child.inOffset))}" duration="${time(total)}"/>`,
        );
        continue;
      }
      const duration = length(child);
      const offset = time(position);
      position += duration;
      if (child.type === 'gap') {
        parts.push(`<gap name="Gap" offset="${offset}" duration="${time(duration)}"/>`);
      } else if (child.type === 'stack') {
        parts.push(`<gap name="${escape(child.name)}" offset="${offset}" duration="${time(duration)}"/>`);
      } else if (child.mediaReference.kind === 'generator' && child.mediaReference.generator === 'title') {
        const title = child.frameleaf?.title;
        parts.push(
          `<title ref="r2" name="${escape(child.name)}" offset="${offset}" duration="${time(duration)}" start="0s"><text><text-style ref="ts${counter}">${escape(title?.text ?? child.name)}</text-style></text><text-style-def id="ts${counter++}"><text-style font="${escape(title?.font ?? 'Helvetica')}" fontSize="${title?.size ?? 63}" alignment="${title?.align ?? 'center'}"/></text-style-def></title>`,
        );
      } else {
        const asset = assetFor(child);
        if (!asset) {
          parts.push(`<gap name="${escape(child.name)}" offset="${offset}" duration="${time(duration)}"/>`);
          continue;
        }
        const speed = child.frameleaf?.speed ?? 1;
        const start = seconds(child.sourceRange.startTime);
        const retime =
          speed !== 1
            ? `<timeMap><timept time="0s" value="0s" interp="linear"/><timept time="${time(duration)}" value="${time(duration * speed)}" interp="linear"/></timeMap>`
            : '';
        const volume = child.frameleaf?.volumeDb ? `<adjust-volume amount="${child.frameleaf.volumeDb}dB"/>` : '';
        parts.push(
          `<asset-clip ref="${asset.id}" name="${escape(child.name)}" offset="${offset}" start="${time(start)}" duration="${time(duration)}"${track.kind === 'audio' ? ' audioRole="dialogue"' : ''}>${retime}${volume}</asset-clip>`,
        );
      }
    }
    return `<spine lane="${lane}" offset="0s">${parts.join('')}</spine>`;
  };
  const video = timeline.tracks.filter((track) => track.kind === 'video');
  const audio = timeline.tracks.filter((track) => track.kind === 'audio');
  const total = Math.max(
    1 / fps,
    ...timeline.tracks.map((track) => track.children.reduce((sum, child) => sum + length(child), 0)),
  );
  // Every track is a storyline connected to one gap the length of the project, pictures above it and
  // sound below, so each keeps its own transitions.
  const lanes = [
    ...video.map((track, index) => storyline(track, index + 1)),
    ...audio.map((track, index) => storyline(track, -(index + 1))),
  ];
  const markers = (timeline.markers ?? [])
    .map(
      (marker) =>
        `<marker start="${time(seconds(marker.markedRange.startTime))}" duration="${time(1 / fps)}" value="${escape(marker.name)}"/>`,
    )
    .join('');
  const resources = [
    `<format id="r1" name="Frameleaf" frameDuration="${den}/${num}s" width="${timeline.canvas.width}" height="${timeline.canvas.height}"/>`,
    `<effect id="r2" name="Basic Title" uid=".../Titles.localized/Bumper:Opener.localized/Basic Title.localized/Basic Title.moti"/>`,
    ...assets
      .values()
      .map(
        (asset) =>
          `<asset id="${asset.id}" name="${escape(asset.name)}" start="0s" duration="${time(asset.end)}" hasVideo="${asset.audioOnly ? 0 : 1}" hasAudio="1"${asset.audioOnly ? '' : ' format="r1"'}><media-rep kind="original-media" src="${escape(fileUrl(asset.key))}"/></asset>`,
      ),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE fcpxml>\n<fcpxml version="1.10"><resources>${resources.join('')}</resources><library><event name="Frameleaf"><project name="${escape(timeline.name)}"><sequence format="r1" duration="${time(total)}" tcStart="0s"><spine><gap name="Frameleaf" offset="0s" duration="${time(total)}" start="0s">${markers}${lanes.join('')}</gap></spine></sequence></project></event></library></fcpxml>\n`;
};

/* ---------------------------------------------------------------- EDL */

const timecode = (frameCount: number, fps: number) => {
  const base = Math.round(fps);
  const total = Math.max(0, Math.round(frameCount));
  const ff = total % base;
  const totalSeconds = Math.floor(total / base);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(Math.floor(totalSeconds / 3600))}:${pad(Math.floor(totalSeconds / 60) % 60)}:${pad(totalSeconds % 60)}:${pad(ff)}`;
};

/** One event list for the first picture track and the sound tracks, starting at 1:00:00:00. */
export const writeEdl = (timeline: Timeline) => {
  const fps = timeline.rate.num / timeline.rate.den;
  const base = Math.round(fps);
  const origin = base * 3600;
  const lines = [`TITLE: ${timeline.name.replaceAll(/[\r\n]/g, ' ').slice(0, 70)}`, 'FCM: NON-DROP FRAME', ''];
  let event = 1;
  const tracks = [
    ...timeline.tracks
      .filter((track) => track.kind === 'video')
      .slice(0, 1)
      .map((track) => ({ track, label: 'V' })),
    ...timeline.tracks
      .filter((track) => track.kind === 'audio')
      .slice(0, 4)
      .map((track, index) => ({ track, label: index === 0 ? 'A' : `A${index + 1}` })),
  ];
  for (const { track, label } of tracks) {
    let position = 0;
    let pending: { frames: number } | null = null;
    let previousReel = 'BL';
    let previousOut = 0;
    for (const child of track.children) {
      if (child.type === 'transition') {
        pending = { frames: Math.round((seconds(child.inOffset) + seconds(child.outOffset)) * fps) };
        continue;
      }
      const duration = Math.round(length(child) * fps);
      const recordIn = origin + Math.round(position * fps);
      position += length(child);
      if (child.type !== 'clip' || child.mediaReference.kind !== 'external') {
        pending = null;
        continue;
      }
      const reel = (
        child.mediaReference.name
          .replace(/\.[^.]+$/, '')
          .replaceAll(/[^A-Za-z0-9]/g, '')
          .slice(0, 8) || 'AX'
      ).toUpperCase();
      const speed = Math.abs(child.frameleaf?.speed ?? 1) || 1;
      const sourceIn = Math.round(seconds(child.sourceRange.startTime) * fps);
      const sourceOut = sourceIn + Math.round(duration * speed);
      const number = String(event++).padStart(3, '0');
      if (pending) {
        lines.push(
          `${number}  ${previousReel.padEnd(8)} ${label.padEnd(5)} C        ${timecode(previousOut, fps)} ${timecode(previousOut, fps)} ${timecode(recordIn, fps)} ${timecode(recordIn, fps)}`,
          `${number}  ${reel.padEnd(8)} ${label.padEnd(5)} D    ${String(pending.frames).padStart(3, '0')} ${timecode(sourceIn, fps)} ${timecode(sourceOut, fps)} ${timecode(recordIn, fps)} ${timecode(recordIn + duration, fps)}`,
        );
      } else {
        lines.push(
          `${number}  ${reel.padEnd(8)} ${label.padEnd(5)} C        ${timecode(sourceIn, fps)} ${timecode(sourceOut, fps)} ${timecode(recordIn, fps)} ${timecode(recordIn + duration, fps)}`,
        );
      }
      if (speed !== 1) {
        lines.push(
          `M2   ${reel.padEnd(8)}       ${(speed * fps).toFixed(1).padStart(5, '0')}    ${timecode(sourceIn, fps)}`,
        );
      }
      lines.push(`* FROM CLIP NAME: ${child.name}`, `* SOURCE FILE: ${child.mediaReference.key}`, '');
      previousReel = reel;
      previousOut = sourceOut;
      pending = null;
    }
  }
  return `${lines.join('\n')}\n`;
};

/* ---------------------------------------------------------------- What stays behind */

/** What the chosen kind of file cannot carry, naming the clips. */
export const sendBackReport = (timeline: Timeline, format: SendBackFormat): SendBackNote[] => {
  const notes = new Map<SendBackNote['code'], Set<string>>();
  const add = (code: SendBackNote['code'], clip: string) => {
    const names = notes.get(code) ?? new Set<string>();
    names.add(clip);
    notes.set(code, names);
  };
  const firstVideo = timeline.tracks.find((track) => track.kind === 'video');
  const visit = (tracks: Track[], nested: boolean) => {
    for (const track of tracks) {
      for (const child of track.children) {
        if (child.type === 'stack') {
          if (format === 'edl' || format === 'fcpxml') {
            add('nests', child.name);
          }
          visit(child.tracks, true);
          continue;
        }
        if (child.type !== 'clip') {
          continue;
        }
        const effects = child.frameleaf?.effects ?? [];
        if (
          effects.some((effect) => /color-wheels|curves|lut|levels|saturation|exposure|temperature/.test(effect.name))
        ) {
          add('grades', child.name);
        }
        if (
          effects.some((effect) => !/color-wheels|curves|lut|levels|saturation|exposure|temperature/.test(effect.name))
        ) {
          add('effects', child.name);
        }
        const title = child.mediaReference.kind === 'generator' && child.mediaReference.generator === 'title';
        if (title && format === 'edl') {
          add('titles', child.name);
        }
        if (format === 'edl' && !nested && track.kind === 'video' && track !== firstVideo) {
          add('upper-tracks', child.name);
        }
        if (format === 'edl' && child.frameleaf?.transform) {
          add('picture-moves', child.name);
        }
      }
    }
  };
  visit(timeline.tracks, false);
  return [...notes].map(([code, clips]) => ({ code, clips: [...clips] }));
};

export const SEND_BACK_FILES: Record<
  SendBackFormat,
  { extension: string; mediaType: string; write: (timeline: Timeline) => string }
> = {
  otio: { extension: 'otio', mediaType: 'application/json', write: writeOtio },
  fcpxml: { extension: 'fcpxml', mediaType: 'application/xml', write: writeFcpxml },
  fcp7: { extension: 'xml', mediaType: 'application/xml', write: writeFcp7Xml },
  edl: { extension: 'edl', mediaType: 'text/plain', write: writeEdl },
};

/** For specs: the clips of a timeline, nests included, in order. */
export const timelineClips = (timeline: Timeline): (Clip | Stack)[] =>
  timeline.tracks.flatMap((track) =>
    track.children.filter((child): child is Clip | Stack => child.type === 'clip' || child.type === 'stack'),
  );
