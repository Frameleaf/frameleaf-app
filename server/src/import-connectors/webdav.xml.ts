import { SaxesParser } from 'saxes';
import { RemoteSourceError } from 'src/import-connectors/remote-source.js';

/**
 * FL-944: reads a PROPFIND answer, which comes from a server a user pointed us at. saxes never fetches
 * a DTD or external entity and treats an unknown entity as an error; a DOCTYPE is refused outright, so
 * nothing can be declared at all. Size, element depth, entries and text length are capped while reading.
 */
export type WebDavEntry = {
  href: string;
  isCollection: boolean;
  size?: number;
  modifiedAt?: string;
  etag?: string;
  favourite: boolean;
};

export type WebDavXmlLimits = { maxBytes: number; maxEntries: number };

export const WEBDAV_XML_LIMITS: WebDavXmlLimits = Object.freeze({ maxBytes: 32 * 1024 * 1024, maxEntries: 50_000 });

const MAX_ELEMENT_DEPTH = 16;
const MAX_TEXT = 8192;
const DAV = 'DAV:';
// An XML namespace name, compared as a string and never requested.
// eslint-disable-next-line unicorn/prefer-https
const OWNCLOUD = 'http://owncloud.org/ns';
const TEXT_ELEMENTS = new Set(['href', 'status', 'getcontentlength', 'getlastmodified', 'getetag', 'oc:favorite']);

const unreadable = () => new RemoteSourceError('The server sent a folder listing that could not be read');
const tooLarge = () => new RemoteSourceError('The server sent a folder listing that is too large');

type Props = Partial<Record<'getcontentlength' | 'getlastmodified' | 'getetag' | 'oc:favorite', string>> & {
  collection?: boolean;
};

export const readMultistatus = async (
  body: AsyncIterable<Uint8Array>,
  limits: WebDavXmlLimits = WEBDAV_XML_LIMITS,
): Promise<WebDavEntry[]> => {
  const entries: WebDavEntry[] = [];
  const names: string[] = [];
  let href = '';
  let merged: Props = {};
  let props: Props = {};
  let status = '';
  let capture: string | null = null;
  let text = '';
  let sawRoot = false;

  const parser = new SaxesParser({ xmlns: true });
  parser.on('error', () => {
    throw unreadable();
  });
  parser.on('doctype', () => {
    throw unreadable();
  });
  parser.on('opentag', (tag) => {
    let name = '';
    if (tag.uri === DAV) {
      name = tag.local;
    } else if (tag.uri === OWNCLOUD) {
      name = `oc:${tag.local}`;
    }
    if (names.length >= MAX_ELEMENT_DEPTH) {
      throw unreadable();
    }
    if (names.length === 0) {
      if (name !== 'multistatus') {
        throw unreadable();
      }
      sawRoot = true;
    }
    if (name === 'response' && names.length === 1) {
      href = '';
      merged = {};
    } else if (name === 'propstat' && names.length === 2) {
      props = {};
      status = '';
    } else if (name === 'collection' && names.at(-1) === 'resourcetype') {
      props.collection = true;
    }
    names.push(name);
    capture = TEXT_ELEMENTS.has(name) ? name : null;
    text = '';
  });
  parser.on('text', (chunk) => {
    if (capture) {
      text += chunk;
      if (text.length > MAX_TEXT) {
        throw tooLarge();
      }
    }
  });
  parser.on('closetag', () => {
    const name = names.pop() ?? '';
    const parent = names.at(-1);
    if (capture === name) {
      const value = text.trim();
      if (name === 'href' && parent === 'response') {
        href = value;
      } else if (name === 'status' && parent === 'propstat') {
        status = value;
      } else if (name !== 'href' && name !== 'status' && parent === 'prop') {
        props[name as keyof Omit<Props, 'collection'>] = value;
      }
    }
    capture = null;
    if (name === 'propstat' && names.length === 2 && /^HTTP\/\d(\.\d)?\s+2\d\d\b/.test(status)) {
      merged = { ...merged, ...props };
    } else if (name === 'response' && names.length === 1) {
      if (entries.length >= limits.maxEntries) {
        throw tooLarge();
      }
      const length = merged.getcontentlength;
      if (href) {
        entries.push({
          href,
          isCollection: merged.collection === true,
          size: length !== undefined && /^\d{1,16}$/.test(length) ? Number(length) : undefined,
          modifiedAt: merged.getlastmodified,
          etag: merged.getetag && merged.getetag.length <= 256 ? merged.getetag : undefined,
          favourite: merged['oc:favorite'] === '1',
        });
      }
    }
  });

  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0;
  const decode = (chunk?: Uint8Array) => {
    try {
      return chunk ? decoder.decode(chunk, { stream: true }) : decoder.decode();
    } catch {
      throw unreadable();
    }
  };
  for await (const chunk of body) {
    size += chunk.byteLength;
    if (size > limits.maxBytes) {
      throw tooLarge();
    }
    parser.write(decode(chunk));
  }
  parser.write(decode());
  parser.close();
  if (!sawRoot) {
    throw unreadable();
  }
  return entries;
};
