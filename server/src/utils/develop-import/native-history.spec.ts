import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { importDarktable } from 'src/utils/develop-import/darktable.js';
import { nativeHistoryXmp, readNativeHistory, validateNativeHistory } from 'src/utils/develop-import/native-history.js';
import { readDevelopXmp } from 'src/utils/develop-import/xmp.js';

const fixture = (name = 'canon') =>
  readFileSync(join(process.cwd(), 'test/fixtures/develop-import', `darktable-native-${name}.xmp`));
const history = () => readNativeHistory(readDevelopXmp(fixture()));

describe('native XMP history boundary', () => {
  it.each(['canon', 'nikon'])('preserves the genuine %s complete history with neutral quick controls', (name) => {
    const nodes = readDevelopXmp(fixture(name));
    const value = readNativeHistory(nodes);
    expect(value.entries).toHaveLength(11);
    expect(value.entries.find((entry) => entry.operation === 'colorin')!.params).toHaveLength(1044 * 2);
    expect(readNativeHistory(readDevelopXmp(Buffer.from(nativeHistoryXmp(value))))).toEqual(value);
    expect(importDarktable(nodes)).toMatchObject({
      version: 1,
      exposure: 0,
      temperature: 0,
      tint: 0,
      imported: { darktable: { replay: value } },
    });
  });
  const withInteger = (operation: string, offset: number, number: number) => {
    const value = history();
    const entry = value.entries.find((entry) => entry.operation === operation)!;
    const params = Buffer.from(entry.params, 'hex');
    params.writeInt32LE(number, offset);
    entry.params = params.toString('hex');
    return value;
  };
  it.each([0, 1, 2, 3, 4, 5, 6, 7, 1024, 1025, 1026, 1027, 1028, 1029, 2049, 2053, 3074])(
    'accepts pinned Bayer/X-Trans/dual demosaic method %s',
    (method) => {
      expect(() => validateNativeHistory(withInteger('demosaic', 12, method))).not.toThrow();
    },
  );
  it.each([256, 257, 258, 259, 260, 261, 513, 517, 770, 1030, 2048, 3073])(
    'refuses a non-enumerated demosaic method %s',
    (method) => {
      expect(() => validateNativeHistory(withInteger('demosaic', 12, method))).toThrow();
    },
  );
  it.each([
    [0, 5],
    [28, 11],
    [40, 6],
  ])('accepts pinned highlights enum at %s = %s', (offset, value) => {
    expect(() => validateNativeHistory(withInteger('highlights', offset, value))).not.toThrow();
  });
  it.each([
    [0, 6],
    [28, 12],
    [40, 7],
  ])('refuses out-of-range highlights enum at %s = %s', (offset, value) => {
    expect(() => validateNativeHistory(withInteger('highlights', offset, value))).toThrow();
  });
  it.each([
    [124, 11],
    [128, 8],
    [132, 4],
    [156, 2],
  ])('accepts pinned color calibration enum at %s = %s', (offset, value) => {
    expect(() => validateNativeHistory(withInteger('channelmixerrgb', offset, value))).not.toThrow();
  });
  it.each([
    [124, 12],
    [128, 9],
    [132, 5],
    [156, 3],
  ])('refuses non-enumerated color calibration at %s = %s', (offset, value) => {
    const descriptor = withInteger('channelmixerrgb', offset, value);
    if (offset === 124 || offset === 128) {
      const entry = descriptor.entries.find((entry) => entry.operation === 'channelmixerrgb')!;
      const params = Buffer.from(entry.params, 'hex');
      params.writeInt32LE(offset === 124 ? 4 : 5, 120);
      entry.params = params.toString('hex');
    }
    expect(() => validateNativeHistory(descriptor)).toThrow();
  });
  it('preserves repeated updates to the same module instance in history order', () => {
    const value = history();
    const exposure = structuredClone(value.entries.find((entry) => entry.operation === 'exposure')!);
    const temperature = structuredClone(value.entries.find((entry) => entry.operation === 'temperature')!);
    const changed = Buffer.from(exposure.params, 'hex');
    changed.writeFloatLE(1.4, 8);
    exposure.params = changed.toString('hex');
    value.entries.push(exposure, temperature, structuredClone(exposure));
    expect(validateNativeHistory(value)).toEqual(value);
    expect(readNativeHistory(readDevelopXmp(Buffer.from(nativeHistoryXmp(value))))).toEqual(value);
  });
  it('reads the genuine uncompressed native exposure-temperature-exposure edit history', () => {
    const value = readNativeHistory(readDevelopXmp(fixture('canon-repeated')));
    expect(value.entries).toHaveLength(14);
    expect(value.entries.slice(11).map((entry) => entry.operation)).toEqual(['exposure', 'temperature', 'exposure']);
    expect(Buffer.from(value.entries[13].params, 'hex').readFloatLE(8)).toBeCloseTo(0.9);
    expect(readNativeHistory(readDevelopXmp(Buffer.from(nativeHistoryXmp(value))))).toEqual(value);
  });
  it.each([
    (v: ReturnType<typeof history>) => {
      Object.assign(v, { orderVersion: 3 });
    },
    (v: ReturnType<typeof history>) => {
      v.entries[0].operation = 'lut3d';
    },
    (v: ReturnType<typeof history>) => {
      v.entries[0].version = 999;
    },
    (v: ReturnType<typeof history>) => {
      v.entries[1].operation = v.entries[0].operation;
    },
    (v: ReturnType<typeof history>) => {
      v.entries[0].params = '00';
    },
    (v: ReturnType<typeof history>) => {
      v.entries[0].blend = '00';
    },
    (v: ReturnType<typeof history>) => {
      const entry = v.entries.find((e) => e.operation === 'colorin')!;
      const bytes = Buffer.from(entry.params, 'hex');
      bytes.writeInt32LE(0, 0);
      bytes.write('/etc/passwd', 4);
      entry.params = bytes.toString('hex');
    },
    (v: ReturnType<typeof history>) => {
      const bytes = Buffer.from(v.entries[0].blend, 'hex');
      bytes.writeUInt32LE(8, 0);
      v.entries[0].blend = bytes.toString('hex');
    },
    (v: ReturnType<typeof history>) => {
      const entry = v.entries.find((e) => e.operation === 'exposure')!;
      const bytes = Buffer.from(entry.params, 'hex');
      bytes.writeFloatLE(Infinity, 8);
      entry.params = bytes.toString('hex');
    },
  ])('refuses unsupported or unsafe descriptors before replay', (change) => {
    const value = history();
    change(value);
    expect(() => validateNativeHistory(value)).toThrow();
  });
  it.each([
    ['darktable:history_end="11"', 'darktable:history_end="10"'],
    ['darktable:iop_order_version="4"', 'darktable:iop_order_version="3"'],
    ['darktable:multi_priority="0"', 'darktable:multi_priority="1"'],
    ['<rdf:Seq />', '<rdf:Seq><rdf:li darktable:mask_id="1"/></rdf:Seq>'],
    ['darktable:params="480000', 'darktable:params="NOTHEX'],
    ['darktable:blendop_version="14"', 'darktable:blendop_version="13"'],
    ['darktable:raw_params="0"', 'darktable:raw_params="1"'],
    ['darktable:auto_presets_applied="1"', 'darktable:auto_presets_applied="0"'],
    ['<darktable:masks_history>', '<darktable:history_end>11</darktable:history_end><darktable:masks_history>'],
  ])('refuses unsafe source XMP %s', (from, to) => {
    expect(() =>
      readNativeHistory(
        readDevelopXmp(
          Buffer.from(
            fixture()
              .toString()
              .replace(from, () => to),
          ),
        ),
      ),
    ).toThrow();
  });
  it('refuses an ambiguous duplicate field within a history entry', () => {
    const xml = fixture()
      .toString()
      .replace(/(<rdf:li\b[^>]+) \/>/, '$1><darktable:operation>rawprepare</darktable:operation></rdf:li>');
    expect(() => readNativeHistory(readDevelopXmp(Buffer.from(xml)))).toThrow();
  });
  it.each([24, 28, 388, 408, 412, 416])('refuses mask/raster references at blend offset %s', (offset) => {
    const value = history();
    const bytes = Buffer.from(value.entries[0].blend, 'hex');
    bytes.writeInt32LE(123, offset);
    value.entries[0].blend = bytes.toString('hex');
    expect(() => validateNativeHistory(value)).toThrow();
  });
  it('refuses an external output ICC profile', () => {
    const value = history();
    const output = value.entries.find((entry) => entry.operation === 'colorout')!;
    const bytes = Buffer.from(output.params, 'hex');
    bytes.write('/private/profile.icc', 4);
    output.params = bytes.toString('hex');
    expect(() => validateNativeHistory(value)).toThrow();
  });
  it('bounds compressed native data before decompression', () => {
    const bomb = `gz99${deflateSync(Buffer.alloc(1024 * 1024)).toString('base64')}`;
    const xml = fixture()
      .toString()
      .replace(/darktable:params="[^"]+"/, () => `darktable:params="${bomb}"`);
    expect(() => readNativeHistory(readDevelopXmp(Buffer.from(xml)))).toThrow();
  });
  it('refuses incomplete native histories rather than quick-rendering selected controls', () => {
    const xml = readFileSync(join(process.cwd(), 'test/fixtures/develop-import/darktable-exposure.xmp'));
    expect(() => importDarktable(readDevelopXmp(xml))).toThrow();
  });
});
