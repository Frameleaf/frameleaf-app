import {
  EMPTY_SOURCE_ARCHIVE_HASH,
  advanceSourceArchiveHash,
  decodeSourceArchiveRecord,
  encodeSourceArchiveRecord,
  sourceArchiveRecordFingerprint,
} from 'src/library-import/source-archive-codec.js';

const row = () => ({
  table: 'photos',
  value: {
    private: true,
    manual: 'café 😀',
    id: 9_007_199_254_740_993n,
    nullable: null,
    coordinates: -0,
    blob: new Uint8Array([0, 1, 255]),
  },
});
const encoded = {
  table: 'photos',
  fields: [
    ['blob', ['blob', 'AAH/']],
    ['coordinates', ['real', '-0']],
    ['id', ['integer', '9007199254740993']],
    ['manual', ['text', 'YwBhAGYA6QAgAD3YAN4=']],
    ['nullable', null],
    ['private', ['boolean', true]],
  ],
};

it('preserves native scalar types, arbitrary bytes, Unicode and negative zero', () => {
  expect(encodeSourceArchiveRecord(row())).toEqual(encoded);
  const restored = decodeSourceArchiveRecord(JSON.parse(JSON.stringify(encoded)));
  expect(restored).toEqual(row());
  expect(Object.is(restored.value.coordinates, -0)).toBe(true);
});
it('matches an independently computed Python hashlib vector', () => {
  expect(EMPTY_SOURCE_ARCHIVE_HASH).toBe('b629e45ed90b2d72e352565c4c7c66933f29e04831bc8dc17b019b3f2a7dc2f0');
  expect(sourceArchiveRecordFingerprint(encoded)).toBe(
    '1504aa9032f559efa8ea0dea2bc977b2b3d41484b925c719b90ea72f9687f9a7',
  );
  expect(advanceSourceArchiveHash(EMPTY_SOURCE_ARCHIVE_HASH, encoded)).toBe(
    '92ac7db72e4c6a67c6fc6eb0491f5c3afea705fe2166f9bb8add70a807bd9f79',
  );
});
it.each(['embedded\0null', '\u{D800}', '\u{DFFF}', '\u{D800}\u{D800}', '\u{FEFF}'])(
  'preserves text that JSONB cannot store directly',
  (value) => {
    const record = encodeSourceArchiveRecord({ table: 'photos', value: { caption: value } });
    expect(decodeSourceArchiveRecord(record).value.caption).toBe(value);
  },
);
it('sorts input column order while retaining number, integer and text identity', () => {
  const input = row();
  expect(
    encodeSourceArchiveRecord({ ...input, value: Object.fromEntries(Object.entries(input.value).toReversed()) }),
  ).toEqual(encoded);
  const fingerprints = [1, 1n, '1', true, null].map((value) =>
    sourceArchiveRecordFingerprint(encodeSourceArchiveRecord({ table: 'photos', value: { value } })),
  );
  expect(new Set(fingerprints).size).toBe(5);
});
it.each([undefined, NaN, Infinity, -Infinity, {}, [], new Date(), () => {}])(
  'refuses unsupported or lossy values without exposing them',
  (value) => {
    expect(() => encodeSourceArchiveRecord({ table: 'photos', value: { private: value } })).toThrow(
      'SOURCE_ARCHIVE_RECORD_INVALID',
    );
  },
);
it.each([
  'password',
  'password_hash',
  'apiKey',
  'access_token',
  'refresh_token',
  'session_id',
  'secret',
  'pinCode',
  'passwordLinkHash',
])('refuses a credential-bearing %s column instead of archiving it', (column) => {
  expect(() => encodeSourceArchiveRecord({ table: 'users', value: { [column]: 'synthetic secret' } })).toThrow(
    'SOURCE_ARCHIVE_CREDENTIAL_COLUMN',
  );
});
it.each([
  { table: 'photos', fields: [['id', ['integer', '01']]] },
  { table: 'photos', fields: [['id', ['real', 'NaN']]] },
  { table: 'photos', fields: [['id', ['real', '1.0']]] },
  { table: 'photos', fields: [['id', ['blob', 'AAH']]] },
  {
    table: 'photos',
    fields: [
      ['b', null],
      ['a', null],
    ],
  },
  {
    table: 'photos',
    fields: [
      ['id', null],
      ['id', null],
    ],
  },
  { table: 'photos', fields: [['password', ['text', 'synthetic secret']]] },
  { ...encoded, extra: true },
])('refuses malformed or noncanonical retained records', (record) => {
  expect(() => decodeSourceArchiveRecord(record)).toThrow('SOURCE_ARCHIVE_');
});
it('rejects a changed digest identity and binds the table and record order', () => {
  expect(() => advanceSourceArchiveHash('not a checksum', encoded)).toThrow('SOURCE_ARCHIVE_HASH_INVALID');
  expect(sourceArchiveRecordFingerprint({ ...encoded, table: 'other' })).not.toBe(
    sourceArchiveRecordFingerprint(encoded),
  );
  const second = encodeSourceArchiveRecord({ table: 'photos', value: { id: 2n } });
  const firstThenSecond = advanceSourceArchiveHash(
    advanceSourceArchiveHash(EMPTY_SOURCE_ARCHIVE_HASH, encoded),
    second,
  );
  const secondThenFirst = advanceSourceArchiveHash(
    advanceSourceArchiveHash(EMPTY_SOURCE_ARCHIVE_HASH, second),
    encoded,
  );
  expect(firstThenSecond).not.toBe(secondThenFirst);
});

it('retains special object-key columns and their fingerprint through decoding', () => {
  const record = {
    table: 'metadata',
    value: JSON.parse(
      '{"__proto__":"retained value","constructor":"manual constructor","prototype":"manual prototype"}',
    ),
  };
  const encoded = encodeSourceArchiveRecord(record);
  expect(encoded.fields.map(([column]) => column)).toEqual(['__proto__', 'constructor', 'prototype']);
  const restored = decodeSourceArchiveRecord(encoded);
  expect(restored).toEqual(record);
  expect(Object.hasOwn(restored.value, '__proto__')).toBe(true);
  expect(Object.getPrototypeOf(restored.value)).toBe(Object.prototype);
  expect(sourceArchiveRecordFingerprint(encodeSourceArchiveRecord(restored))).toBe(
    sourceArchiveRecordFingerprint(encoded),
  );
});
