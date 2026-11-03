import { describe, expect, it } from 'vitest';
import { resolveEnteComponents } from 'src/library-import/ente-files.js';
import content from 'src/library-import/fixtures/ente/0.4.2-content.json' with { type: 'json' };

const component = { role: 'original', path: 'photo.jpg', size: 42, hash: Buffer.alloc(64, 1).toString('base64') };
const record = { ente: { fileID: '9007199254740993', type: 'image', component: 'original', components: [component] } };
const inventory = { id: '9007199254740993', ownerId: '2', type: 'image', albumIds: ['3'] };
const album = { ente: { albumID: '3', ownerID: '7' } };

describe('Ente export component resolution', () => {
  it.each(content.cases)('matches the native $account export without changing file ownership', (source) => {
    expect(resolveEnteComponents(source.file, source.inventory, source.album)).toEqual([
      {
        albumId: content.sharing[0].albumId,
        fileId: source.file.ente.fileID,
        ownerId: content.users.alice,
        role: 'original',
        path: source.original.path,
        bytes: source.original.bytes,
        sourceHash: source.file.ente.components[0].hash,
      },
    ]);
    if (source.account === 'bob') expect(source.root.userID).not.toBe(content.users.alice);
  });

  it('joins the authenticated inventory by source ID and retains the file owner', () => {
    expect(resolveEnteComponents(record, inventory, album)).toEqual([
      {
        albumId: '3',
        fileId: inventory.id,
        ownerId: '2',
        role: 'original',
        path: component.path,
        bytes: '42',
        sourceHash: component.hash,
      },
    ]);
  });

  it('retains both Live Photo components under one source identity', () => {
    const components = [
      { ...component, role: 'image' },
      { ...component, role: 'video', path: 'photo.mov', size: 84 },
    ];
    const live = { ente: { ...record.ente, type: 'livePhoto', component: 'image', components } };
    expect(resolveEnteComponents(live, { ...inventory, type: 'livephoto' }, album)).toEqual([
      expect.objectContaining({ fileId: inventory.id, role: 'image', bytes: '42' }),
      expect.objectContaining({ fileId: inventory.id, role: 'video', bytes: '84' }),
    ]);
  });

  it.each([
    { ...inventory, id: 'different' },
    { ...inventory, id: '1' },
    { ...inventory, ownerId: null },
    { ...inventory, ownerId: '' },
    { ...inventory, ownerId: '0' },
    { ...inventory, ownerId: '9223372036854775808' },
    { ...inventory, ownerId: '02' },
    { ...inventory, ownerId: '2e1' },
    { ...inventory, ownerId: 2 },
    { ...inventory, type: 'video' },
    { ...inventory, albumIds: [] },
    { ...inventory, albumIds: ['3', '3'] },
    { ...inventory, albumIds: [3] },
  ])('refuses missing or conflicting inventory evidence %s', (row) => {
    expect(() => resolveEnteComponents(record, row, album)).toThrow('ENTE_FILES_INVALID');
  });

  it.each([null, { ente: { albumID: '4', ownerID: '7' } }, { ente: { albumID: '3', ownerID: null } }])(
    'refuses missing or mismatched album identity %s',
    (row) => {
      expect(() => resolveEnteComponents(record, inventory, row)).toThrow('ENTE_FILES_INVALID');
    },
  );

  it.each([
    'other/photo.jpg',
    '',
    '../photo.jpg',
    '/photo.jpg',
    'a/../photo.jpg',
    String.raw`a\photo.jpg`,
    'https://source/photo.jpg',
    'a\0.jpg',
  ])('refuses unsafe component paths %s', (path) => {
    expect(() =>
      resolveEnteComponents({ ente: { ...record.ente, components: [{ ...component, path }] } }, inventory, album),
    ).toThrow('ENTE_FILES_INVALID');
  });

  it.each([
    { size: -1 },
    { size: 1.5 },
    { size: Number.MAX_SAFE_INTEGER + 1 },
    { size: '42' },
    { hash: '' },
    { hash: Buffer.alloc(32).toString('base64') },
    { hash: 'a'.repeat(88) },
    { role: 'thumbnail' },
  ])('refuses malformed component evidence %s', (changed) => {
    expect(() =>
      resolveEnteComponents({ ente: { ...record.ente, components: [{ ...component, ...changed }] } }, inventory, album),
    ).toThrow('ENTE_FILES_INVALID');
  });

  it('refuses missing, duplicate or inconsistent component roles and paths', () => {
    for (const components of [[], [component, component], [{ ...component, role: 'image' }]]) {
      expect(() => resolveEnteComponents({ ente: { ...record.ente, components } }, inventory, album)).toThrow(
        'ENTE_FILES_INVALID',
      );
    }
    for (const components of [
      [{ ...component, role: 'image' }],
      [
        { ...component, role: 'image' },
        { ...component, role: 'video' },
      ],
      [{ ...component, role: 'image' }, { ...component, role: 'video', path: 'photo.mov' }, component],
    ]) {
      expect(() =>
        resolveEnteComponents(
          { ente: { ...record.ente, type: 'livePhoto', component: 'image', components } },
          { ...inventory, type: 'livephoto' },
          album,
        ),
      ).toThrow('ENTE_FILES_INVALID');
    }
    expect(() => resolveEnteComponents({ ente: { ...record.ente, component: 'video' } }, inventory, album)).toThrow(
      'ENTE_FILES_INVALID',
    );
  });
});
