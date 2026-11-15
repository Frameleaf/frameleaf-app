/**
 * An edit decision list (CMX 3600 `.edl`) to the neutral model (FL-1547). An EDL carries cuts, timing,
 * dissolves and wipes, speed (M2) and, as comments, clip names, source files, markers and ASC CDL
 * grades. Effects, titles and picture moves are not in this kind of file, and the report says so.
 *
 * An EDL does not state its frame rate: the caller passes the one the person chose, otherwise it is
 * read from the timecode (drop frame means 29.97; frame numbers of 24 and up mean 25 or 30).
 */
import type { Cdl, Clip, InterchangeProject, Marker, Track } from 'src/utils/studio-interchange/model.js';
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

const MAX_BYTES = 16 * 1024 * 1024;
const MAX_EVENTS = 100_000;
const TIMECODE = String.raw`\d{1,2}[:;.]\d{2}[:;.]\d{2}[:;.]\d{2}`;
const EVENT = new RegExp(
  String.raw`^(\d{1,6})\s+(\S+)\s+(\S+)\s+(C|D|W\d{3}|K[BO]?\d*)\s+(?:(\d{1,4})\s+)?(${TIMECODE})\s+(${TIMECODE})\s+(${TIMECODE})\s+(${TIMECODE})`,
  'i',
);
const MOTION = new RegExp(String.raw`^M2\s+(\S+)\s+(-?\d+(?:\.\d+)?)\s+(${TIMECODE})`, 'i');

type Rate = { num: number; den: number };

/** Frames from a timecode, counting drop frame (29.97 and 59.94) the SMPTE way. */
export const timecodeFrames = (timecode: string, rate: Rate): number => {
  const [hours, minutes, secondsPart, frames] = timecode.split(/[:;.]/).map(Number);
  const nominal = Math.round(rate.num / rate.den);
  const dropFrame = rate.den === 1001 && (nominal === 30 || nominal === 60) && timecode.includes(';');
  const totalMinutes = hours * 60 + minutes;
  const total = (totalMinutes * 60 + secondsPart) * nominal + frames;
  if (!dropFrame) {
    return total;
  }
  const drop = nominal === 30 ? 2 : 4;
  return total - drop * (totalMinutes - Math.floor(totalMinutes / 10));
};

type Event = {
  number: string;
  reel: string;
  tracks: string;
  kind: string;
  transitionFrames: number;
  sourceIn: string;
  sourceOut: string;
  recordIn: string;
  recordOut: string;
  name?: string;
  file?: string;
  effect?: string;
  speed?: number;
  cdl?: Partial<Cdl>;
};

const MARKER_COLOURS = new Set([
  'RED',
  'PINK',
  'ORANGE',
  'YELLOW',
  'GREEN',
  'CYAN',
  'BLUE',
  'PURPLE',
  'MAGENTA',
  'BLACK',
  'WHITE',
]);

/** The rate an EDL implies when no one says. */
const guessRate = (dropFrame: boolean, events: readonly Event[]): Rate => {
  if (dropFrame) {
    return { num: 30_000, den: 1001 };
  }
  let highest = 0;
  for (const event of events) {
    for (const timecode of [event.sourceIn, event.sourceOut, event.recordIn, event.recordOut]) {
      highest = Math.max(highest, Number(timecode.split(/[:;.]/, 4)[3]));
    }
  }
  return highest >= 25 ? { num: 30, den: 1 } : highest >= 24 ? { num: 25, den: 1 } : { num: 24, den: 1 };
};

const parseCdl = (comment: string, into: Partial<Cdl>) => {
  const sop = comment.match(/ASC_SOP\s*\(([^)]*)\)\s*\(([^)]*)\)\s*\(([^)]*)\)/i);
  if (sop) {
    const triple = (value: string) => {
      const parts = value.trim().split(/\s+/).map(Number);
      return parts.length === 3 && parts.every((part) => Number.isFinite(part))
        ? (parts as [number, number, number])
        : undefined;
    };
    into.slope = triple(sop[1]);
    into.offset = triple(sop[2]);
    into.power = triple(sop[3]);
  }
  const sat = comment.match(/ASC_SAT\s+(-?\d+(?:\.\d+)?)/i);
  if (sat) {
    into.saturation = Number(sat[1]);
  }
};

export const readEdl = (bytes: Buffer | string, options: { rate?: Rate } = {}): InterchangeProject => {
  const length = typeof bytes === 'string' ? Buffer.byteLength(bytes) : bytes.length;
  if (length > MAX_BYTES) {
    throw new InterchangeReadError('too-large', 'The edit decision list is too large to read');
  }
  const lines = (typeof bytes === 'string' ? bytes : bytes.toString('latin1')).split(/\r\n|\r|\n/);
  let title = '';
  let dropFrame = false;
  const events: Event[] = [];
  const locators: { timecode: string; colour?: string; name: string }[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      continue;
    }
    const titleMatch = line.match(/^TITLE:\s*(.*)$/i);
    if (titleMatch) {
      title = titleMatch[1].trim();
      continue;
    }
    if (/^FCM:/i.test(line)) {
      dropFrame = /\bDROP FRAME\b/i.test(line) && !/NON-DROP/i.test(line);
      continue;
    }
    const event = line.match(EVENT);
    if (event) {
      if (events.length >= MAX_EVENTS) {
        throw new InterchangeReadError('too-complex', 'The edit decision list has too many events to read');
      }
      events.push({
        number: event[1],
        reel: event[2],
        tracks: event[3].toUpperCase(),
        kind: event[4].toUpperCase(),
        transitionFrames: Number(event[5] ?? 0),
        sourceIn: event[6],
        sourceOut: event[7],
        recordIn: event[8],
        recordOut: event[9],
      });
      continue;
    }
    const motion = line.match(MOTION);
    const last = events.at(-1);
    if (motion && last) {
      last.speed = Number(motion[2]);
      continue;
    }
    if (!line.startsWith('*') || !last) {
      if (line.startsWith('*')) {
        const locator = line.match(new RegExp(String.raw`^\*\s*LOC:\s*(${TIMECODE})\s+(\w+)?\s*(.*)$`, 'i'));
        if (locator) {
          locators.push({ timecode: locator[1], colour: locator[2], name: locator[3] });
        }
      }
      continue;
    }
    const comment = line.replace(/^\*\s*/, '');
    const field = comment.match(/^(FROM CLIP NAME|TO CLIP NAME|CLIP NAME|SOURCE FILE|EFFECT NAME):\s*(.*)$/i);
    if (field) {
      const key = field[1].toUpperCase();
      const value = field[2].trim();
      if (key === 'SOURCE FILE') {
        last.file = value;
      } else if (key === 'EFFECT NAME') {
        last.effect = value;
      } else if (key === 'TO CLIP NAME' || !last.name) {
        last.name = value;
      }
      continue;
    }
    const locator = comment.match(new RegExp(String.raw`^LOC:\s*(${TIMECODE})\s+(\w+)?\s*(.*)$`, 'i'));
    if (locator) {
      locators.push({ timecode: locator[1], colour: locator[2], name: locator[3] });
      continue;
    }
    if (/ASC_(SOP|SAT)/i.test(comment)) {
      last.cdl ??= {};
      parseCdl(comment, last.cdl);
    }
  }
  if (events.length === 0) {
    throw new InterchangeReadError('empty', 'This edit decision list has no events in it');
  }

  const notices: InterchangeNotice[] = [
    {
      code: 'format-limits',
      what: 'Colour, effects, titles and picture moves',
      became: 'Not in this kind of file: an edit decision list carries the cuts, timing and dissolves only',
    },
  ];
  let rate = options.rate;
  if (!rate) {
    rate = guessRate(dropFrame, events);
    notices.push({
      code: 'format-limits',
      what: 'The frame rate, which an edit decision list does not state',
      became: `Read at ${Math.round((rate.num / rate.den) * 1000) / 1000} frames a second`,
    });
  }
  const fps = rate.num / rate.den;
  const frames = (timecode: string) => timecodeFrames(timecode, rate);
  const origin = Math.min(...events.map((event) => frames(event.recordIn)));

  const video: Placed[] = [];
  const audio = new Map<string, Placed[]>();
  const transitions: PlacedTransition[] = [];
  for (const event of events) {
    const start = (frames(event.recordIn) - origin) / fps;
    const duration = (frames(event.recordOut) - frames(event.recordIn)) / fps;
    if (event.kind !== 'C' && event.transitionFrames > 0) {
      transitions.push({
        name:
          event.kind === 'D' ? 'SMPTE_Dissolve' : event.kind.startsWith('W') ? `Wipe ${event.kind.slice(1)}` : 'Key',
        start,
        duration: event.transitionFrames / fps,
        edit: start,
      });
    }
    if (duration <= 0) {
      continue;
    }
    const black = /^(BL|BLK|BLACK)$/i.test(event.reel);
    const name = event.name ?? event.reel;
    const key = event.file ?? event.name ?? event.reel;
    const speed = event.speed === undefined ? undefined : event.speed / fps;
    const cdl = event.cdl;
    const clip: Clip = {
      type: 'clip',
      name: fileNameOf(name),
      sourceRange: timeRange(frames(event.sourceIn) / fps, duration, fps),
      mediaReference: black
        ? { kind: 'generator', generator: 'solid', name: 'Black' }
        : {
            kind: 'external',
            key,
            name: fileNameOf(key),
            ...(kindFromName(key) && { facts: { kind: kindFromName(key) } }),
          },
      ...(((speed !== undefined && speed !== 1) || cdl?.slope || event.effect) && {
        frameleaf: {
          ...(speed !== undefined && speed !== 1 && { speed: Math.round(speed * 1000) / 1000 }),
          ...(cdl?.slope &&
            cdl.offset &&
            cdl.power && {
              grade: {
                cdl: { slope: cdl.slope, offset: cdl.offset, power: cdl.power, saturation: cdl.saturation ?? 1 },
              },
            }),
          ...(event.effect && { effects: [{ name: event.effect }] }),
        },
      }),
      metadata: { edl: { event: event.number, reel: event.reel } },
    };
    const tracks = event.tracks;
    if ((tracks.includes('V') || tracks === 'B') && (!black || tracks.includes('V'))) {
      video.push({ start, duration, item: clip });
    }
    const audioTracks =
      tracks === 'B' ? ['A1'] : tracks.startsWith('AA') ? ['A1', 'A2'] : (tracks.match(/A\d*/g) ?? []);
    for (const track of audioTracks) {
      const label = track === 'A' ? 'A1' : track;
      const list = audio.get(label) ?? [];
      list.push({ start, duration, item: { ...clip, frameleaf: { ...clip.frameleaf, grade: undefined } } });
      audio.set(label, list);
    }
  }

  const markers: Marker[] = locators.map((locator) => {
    const colour = locator.colour?.toUpperCase();
    const known = colour && MARKER_COLOURS.has(colour);
    return {
      name: (known ? locator.name : `${locator.colour ?? ''} ${locator.name}`).trim() || 'Marker',
      markedRange: timeRange((frames(locator.timecode) - origin) / fps, 0, fps),
      ...(known && { color: colour }),
    };
  });
  const tracks: Track[] = [
    ...placeTracks('video', 'V1', video, transitions, fps),
    ...[...audio]
      .toSorted(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
      .flatMap(([label, placed]) => placeTracks('audio', label, placed, transitions, fps)),
  ];
  return {
    source: 'edl',
    timelines: [
      {
        name: title || 'Edit decision list',
        rate,
        canvas: { width: 1920, height: 1080 },
        tracks,
        ...(markers.length > 0 && { markers }),
      },
    ],
    notices,
  };
};
