/**
 * FL-1285: read the two Log markers that live in the MP4/MOV box structure and that neither ffprobe
 * nor exiftool's JSON output surfaces reliably:
 *
 * - Apple writes a `logs` box inside the video sample entry (`moov/trak/mdia/minf/stbl/stsd/<entry>`)
 *   whose payload is the CoreVideo identifier, e.g. `com.apple.rec2020.apple-log`. ffmpeg ignores it.
 * - Sony writes NonRealTimeMeta XML in a `meta` box (handler `nrtm`) holding
 *   `<Item name="CaptureGammaEquation" value="s-log3-cine"/>` and `CaptureColorPrimaries`. exiftool
 *   reads it, but its JSON output keeps only the first of the repeated `Item` elements.
 *
 * Only the `moov` and top-level `meta` boxes are read (never `mdat`), each capped in size.
 */

export interface ContainerLogSignals {
  sampleEntryLogTag: string | null;
  sonyCaptureGamma: string | null;
  sonyCaptureGamut: string | null;
}

export type ByteReader = (position: number, length: number) => Promise<Buffer>;

const MAX_BOX_BYTES = 64 * 1024 * 1024;
const MAX_XML_BYTES = 4 * 1024 * 1024;
const MAX_TOP_LEVEL_BOXES = 4096;
/** Size of the fixed part of a visual sample entry (8-byte header + 78 bytes), after which child boxes start. */
const VISUAL_SAMPLE_ENTRY_HEADER = 86;
const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'udta']);

interface Box {
  type: string;
  start: number;
  bodyStart: number;
  end: number;
}

const isFourCc = (buffer: Buffer, offset: number) => {
  for (let i = 0; i < 4; i++) {
    const c = buffer[offset + i];
    if (c === undefined || c < 0x20 || c > 0x7e) {
      return false;
    }
  }
  return true;
};

/** The child boxes of `buffer[start, end)`; stops at the first malformed header. */
function* childBoxes(buffer: Buffer, start: number, end: number): Generator<Box> {
  let offset = start;
  while (offset + 8 <= end) {
    let size = buffer.readUInt32BE(offset);
    let header = 8;
    if (!isFourCc(buffer, offset + 4)) {
      return;
    }
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    if (size === 1) {
      if (offset + 16 > end) {
        return;
      }
      size = Number(buffer.readBigUInt64BE(offset + 8));
      header = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < header || offset + size > end) {
      return;
    }
    yield { type, start: offset, bodyStart: offset + header, end: offset + size };
    offset += size;
  }
}

const readLogsPayload = (buffer: Buffer, box: Box) => {
  const value = buffer
    .toString('latin1', box.bodyStart, Math.min(box.end, box.bodyStart + 256))
    .replaceAll('\0', '')
    .trim();
  return /^[\w.-]+$/.test(value) ? value : null;
};

const readXmlItems = (xml: string) => {
  const items = new Map<string, string>();
  for (const [element] of xml.matchAll(/<Item\b[^>]*>/g)) {
    const name = /\bname="([^"]*)"/.exec(element)?.[1];
    const value = /\bvalue="([^"]*)"/.exec(element)?.[1];
    if (name && value !== undefined && !items.has(name)) {
      items.set(name, value);
    }
  }
  return items;
};

const visit = (buffer: Buffer, start: number, end: number, signals: ContainerLogSignals) => {
  for (const box of childBoxes(buffer, start, end)) {
    if (CONTAINERS.has(box.type)) {
      visit(buffer, box.bodyStart, box.end, signals);
      continue;
    }
    switch (box.type) {
      case 'meta': {
        // ISO `meta` is a full box (4 bytes of version/flags first); QuickTime's `meta` is not.
        const isFullBox = box.bodyStart + 4 <= box.end && buffer.readUInt32BE(box.bodyStart) === 0;
        visit(buffer, isFullBox ? box.bodyStart + 4 : box.bodyStart, box.end, signals);
        break;
      }
      case 'xml ': {
        const bodyStart = box.bodyStart + 4; // full box
        if (box.end - bodyStart <= MAX_XML_BYTES && bodyStart < box.end) {
          const items = readXmlItems(buffer.toString('utf8', bodyStart, box.end));
          signals.sonyCaptureGamma ??= items.get('CaptureGammaEquation') ?? null;
          signals.sonyCaptureGamut ??= items.get('CaptureColorPrimaries') ?? null;
        }
        break;
      }
      case 'stsd': {
        // full box + entry count, then one box per sample entry
        for (const entry of childBoxes(buffer, box.bodyStart + 8, box.end)) {
          for (const child of childBoxes(buffer, entry.start + VISUAL_SAMPLE_ENTRY_HEADER, entry.end)) {
            if (child.type === 'logs') {
              signals.sampleEntryLogTag ??= readLogsPayload(buffer, child);
            }
          }
        }
        break;
      }
    }
  }
};

/** Walk the top-level boxes with positioned reads and collect the Log markers. */
export const readContainerLogSignals = async (read: ByteReader, fileSize: number): Promise<ContainerLogSignals> => {
  const signals: ContainerLogSignals = { sampleEntryLogTag: null, sonyCaptureGamma: null, sonyCaptureGamut: null };
  let offset = 0;
  for (let count = 0; count < MAX_TOP_LEVEL_BOXES && offset + 8 <= fileSize; count++) {
    const header = await read(offset, Math.min(16, fileSize - offset));
    if (header.length < 8 || !isFourCc(header, 4)) {
      break;
    }
    const type = header.toString('latin1', 4, 8);
    let size = header.readUInt32BE(0);
    let headerSize = 8;
    if (size === 1) {
      if (header.length < 16) {
        break;
      }
      size = Number(header.readBigUInt64BE(8));
      headerSize = 16;
    } else if (size === 0) {
      size = fileSize - offset;
    }
    if (size < headerSize || offset + size > fileSize) {
      break;
    }
    if ((type === 'moov' || type === 'meta') && size <= MAX_BOX_BYTES) {
      const box = await read(offset, size);
      if (box.length === size) {
        // Visit the box itself as the only child of a one-box buffer.
        visit(box, 0, box.length, signals);
      }
    }
    offset += size;
  }
  return signals;
};
