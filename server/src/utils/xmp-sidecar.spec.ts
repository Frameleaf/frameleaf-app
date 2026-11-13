import { MAX_XMP_BYTES, validateXmp } from 'src/utils/xmp-sidecar.js';

const root = '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">';

describe('XMP sidecar validation', () => {
  it('accepts namespace-aware RDF wrapped in an XMP packet', () => {
    const packet = '<?xpacket begin=""?>' + root + '<rdf:Description/></rdf:RDF><?xpacket end="w"?>';
    expect(() => validateXmp(Buffer.from(packet))).not.toThrow();
  });

  it('rejects malformed XML, other XML, DTDs and oversized packets', () => {
    for (const invalid of [
      Buffer.from(root),
      Buffer.from('<xml/>'),
      Buffer.from('<!DOCTYPE test>' + root + '</rdf:RDF>'),
      Buffer.alloc(MAX_XMP_BYTES + 1),
    ]) {
      expect(() => validateXmp(invalid)).toThrow();
    }
  });
});
