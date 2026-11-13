import { BadRequestException } from '@nestjs/common';
import { SaxesParser } from 'saxes';

export const MAX_XMP_BYTES = 1024 * 1024;

export function validateXmp(data: Buffer): void {
  if (data.length === 0 || data.length > MAX_XMP_BYTES) {
    throw new BadRequestException('An XMP sidecar must be between 1 byte and 1 MiB');
  }
  let rdf = false;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(data);
    const parser = new SaxesParser({ xmlns: true });
    parser.on('doctype', () => {
      throw new Error('DTD not allowed');
    });
    parser.on('opentag', ({ local, uri }) => {
      if (local === 'RDF' && uri === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#') rdf = true;
    });
    parser.write(text).close();
    if (!rdf) throw new Error('Missing RDF');
  } catch {
    throw new BadRequestException('The file must be a well-formed XMP sidecar');
  }
}
