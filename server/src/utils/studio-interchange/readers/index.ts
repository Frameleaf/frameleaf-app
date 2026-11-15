/**
 * Picks the reader for a project file another editor made (FL-1546, FL-1547) and reads it, with any
 * CDL or LUT files that came with it. Bundles that hold the project beside its media (`.fcpxmld`,
 * `.otioz`, `.otiod`, uploaded as ZIP archives) are read through the bundle importer's ZIP reader and
 * its limits; the entries other than the project are returned so the job can add the carried media.
 */
import type { InterchangeProject } from 'src/utils/studio-interchange/model.js';
import { ZipByteSource, ZipEntry, readZipDirectory, readZipEntry } from 'src/utils/studio-bundle.js';
import { readAaf } from 'src/utils/studio-interchange/readers/aaf.js';
import { InterchangeReadError } from 'src/utils/studio-interchange/readers/common.js';
import { readEdl } from 'src/utils/studio-interchange/readers/edl.js';
import { readFcp7Xml } from 'src/utils/studio-interchange/readers/fcp7.js';
import { readFcpxml } from 'src/utils/studio-interchange/readers/fcpxml.js';
import { readOtio } from 'src/utils/studio-interchange/readers/otio.js';
import { readPrproj } from 'src/utils/studio-interchange/readers/prproj.js';
import { readResolve } from 'src/utils/studio-interchange/readers/resolve.js';
import { InterchangeSidecar, applySidecars } from 'src/utils/studio-interchange/readers/sidecars.js';
import { INTERCHANGE_ZIP_LIMITS, MAX_DOCUMENT_BYTES } from 'src/utils/studio-interchange/readers/zip-limits.js';

/** The file kinds the import accepts, by extension. */
export const INTERCHANGE_EXTENSIONS = [
  'fcpxml',
  'fcpxmld',
  'xml',
  'otio',
  'otioz',
  'otiod',
  'edl',
  'prproj',
  'aaf',
] as const;
export const INTERCHANGE_SIDECAR_EXTENSIONS = ['cdl', 'cc', 'ccc', 'cube'] as const;

export type InterchangeReadResult = {
  project: InterchangeProject;
  /** Media carried inside the archive, by the path the project uses for it. */
  carried: Map<string, ZipEntry>;
};

export const extensionOf = (name: string) => name.split('.').at(-1)?.toLowerCase() ?? '';

const bufferSource = (bytes: Buffer): ZipByteSource => ({
  size: bytes.length,
  read: (position, length) => Promise.resolve(bytes.subarray(position, position + length)),
});

/** An XML file is Final Cut Pro XML or Final Cut Pro 7 XML; the root element says which. */
const readXml = (bytes: Buffer) => {
  const head = bytes.subarray(0, 4096).toString('utf8');
  if (/<fcpxml[\s>]/.test(head)) {
    return readFcpxml(bytes);
  }
  if (/<xmeml[\s>]/.test(head)) {
    return readFcp7Xml(bytes);
  }
  throw new InterchangeReadError('unsupported', 'This XML file is not a Final Cut Pro or Final Cut Pro 7 project');
};

const readArchive = async (
  source: ZipByteSource,
  document: (name: string) => boolean,
  read: (bytes: Buffer) => InterchangeProject,
): Promise<InterchangeReadResult> => {
  let directory;
  try {
    directory = await readZipDirectory(source, INTERCHANGE_ZIP_LIMITS);
  } catch {
    throw new InterchangeReadError('malformed', 'This bundle could not be opened; upload it as a ZIP archive');
  }
  const entries = directory.entries.filter((entry) =>
    entry.name.split('/').every((part) => !part.startsWith('__MACOSX')),
  );
  const projectEntry = entries
    .filter((entry) => document(entry.name))
    .toSorted((a, b) => a.name.split('/').length - b.name.split('/').length)[0];
  if (!projectEntry) {
    throw new InterchangeReadError('empty', 'There is no project inside this bundle');
  }
  const project = read(await readZipEntry(source, projectEntry, MAX_DOCUMENT_BYTES));
  // Paths inside the project are relative to the folder that holds it.
  const root = projectEntry.name.includes('/')
    ? projectEntry.name.slice(0, projectEntry.name.lastIndexOf('/') + 1)
    : '';
  const carried = new Map<string, ZipEntry>();
  for (const entry of entries) {
    if (entry !== projectEntry && !entry.name.endsWith('/') && entry.name.startsWith(root)) {
      carried.set(entry.name.slice(root.length), entry);
    }
  }
  return { project, carried };
};

/**
 * Reads one project file. `source` is the uploaded file; small single files may be passed as bytes.
 * `rate` is the frame rate the person chose for an EDL, which does not state its own.
 */
export const readInterchangeFile = async (
  name: string,
  source: ZipByteSource | Buffer,
  options: { sidecars?: readonly InterchangeSidecar[]; rate?: { num: number; den: number } } = {},
): Promise<InterchangeReadResult> => {
  const extension = extensionOf(name);
  const zip = Buffer.isBuffer(source) ? bufferSource(source) : source;
  const whole = async () => {
    if (zip.size > MAX_DOCUMENT_BYTES) {
      throw new InterchangeReadError('too-large', 'The project file is too large to read');
    }
    return Buffer.isBuffer(source) ? source : zip.read(0, zip.size);
  };
  let result: InterchangeReadResult;
  switch (extension) {
    case 'fcpxml': {
      result = { project: readFcpxml(await whole()), carried: new Map() };
      break;
    }
    case 'xml': {
      result = { project: readXml(await whole()), carried: new Map() };
      break;
    }
    case 'fcpxmld': {
      result = await readArchive(zip, (entry) => /(^|\/)Info\.fcpxml$/i.test(entry), readFcpxml);
      break;
    }
    case 'otio': {
      result = { project: readOtio(await whole()), carried: new Map() };
      break;
    }
    case 'otioz':
    case 'otiod': {
      result = await readArchive(zip, (entry) => /(^|\/)content\.otio$/i.test(entry), readOtio);
      break;
    }
    case 'drp':
    case 'drt': {
      result = { project: await readResolve(zip), carried: new Map() };
      break;
    }
    case 'aaf': {
      result = { project: readAaf(await whole()), carried: new Map() };
      break;
    }
    case 'prproj': {
      result = { project: readPrproj(await whole()), carried: new Map() };
      break;
    }
    case 'edl': {
      result = { project: readEdl(await whole(), { rate: options.rate }), carried: new Map() };
      break;
    }
    default: {
      throw new InterchangeReadError('unsupported', 'Frameleaf cannot read this kind of project file yet');
    }
  }
  if (options.sidecars?.length) {
    applySidecars(result.project, options.sidecars);
  }
  return result;
};
