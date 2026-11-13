import { BinaryField } from 'exiftool-vendored';
import { collectAllMetadata } from 'src/utils/all-metadata.js';

describe('all photo metadata', () => {
  it('retains grouped duplicate maker notes and replaces binary data with its size', () => {
    const result = collectAllMetadata(
      [
        {
          name: 'Original',
          values: {
            'Canon:CameraTemperature': 24,
            'Canon:Copy1:CameraTemperature': 25,
            'Canon:PreviewImage': new BinaryField(2500, 'preview'),
            'System:Directory': '/private',
          },
        },
        { name: 'Sidecar', values: { 'XMP-dc:Title': 'Photo title' } },
      ],
      false,
    );
    expect(result).toEqual({
      groups: [
        {
          name: 'Original: Canon',
          tags: [
            { key: 'CameraTemperature', value: '24' },
            { key: 'Copy1:CameraTemperature', value: '25' },
            { key: 'PreviewImage', value: '(Binary data 2500 bytes)' },
          ],
        },
        { name: 'Sidecar: XMP-dc', tags: [{ key: 'Title', value: 'Photo title' }] },
      ],
      truncated: false,
    });
  });

  it('caps UTF-8 JSON bytes and hides creator credits from shared-link viewers', () => {
    const result = collectAllMetadata(
      [
        {
          name: 'Original',
          values: {
            'Canon:Opaque': '😎'.repeat(600_000),
            'IFD0:Artist': 'Private credit',
            'GPS:GPSAltitude': 42,
          },
        },
      ],
      true,
    );

    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(2 * 1024 * 1024);
    expect(result.groups).toEqual([{ name: 'Original: GPS', tags: [{ key: 'GPSAltitude', value: '42' }] }]);
  });
});
