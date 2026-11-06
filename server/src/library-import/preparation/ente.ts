import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ENTE_EXPORT_SCHEMA_SHA256, readEnteManifest } from 'src/library-import/ente-files.js';
import fixture from 'src/library-import/fixtures/ente/0.4.2-media.json' with { type: 'json' };
import { PLACEHOLDER_SHA256 } from 'src/library-import/preparation/prepare.js';
import {
  type OpenedPreparationSource,
  type PreparationAdapter,
  unrestrictedLogin,
} from 'src/library-import/preparation/types.js';

/** `ente photos export <folder>` writes this; `ente photos file list --all --json` is saved beside it by the user. */
export const ENTE_EXPORT_FILE = 'export.json';
export const ENTE_INVENTORY_FILE = 'ente-files.json';
/** The CLI's own export history, not the account's trash: never imported. */
const TRASH = 'Trash';
/** The mapper reads paths below an account directory; the Manager mounts one account's export as the root. */
const ACCOUNT = 'export';

const refuse = (code: string): never => {
  throw new Error('Ente source refused: ' + code);
};
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const readJSON = async (path: string, code: string) => {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    return refuse(code);
  }
};
const sharedFileLoss = (id: string) => ({ code: 'ENTE_SHARED_FILE_NOT_IMPORTED', entityId: id, acknowledged: false });
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
const blake2b = async (path: string) => {
  const hash = createHash('blake2b512');
  for await (const bytes of createReadStream(path)) hash.update(bytes as Buffer);
  return hash.digest('base64');
};

/*
 * Best effort keeps only the fields the qualified contract reads. Anything else (a renamed enum, a changed type)
 * still refuses: inventing looser parsing would import guesses.
 */
type Shape = true | [Shape] | { [key: string]: Shape };
const project = (value: unknown, shape: Shape): unknown => {
  if (shape === true || !isRecord(value)) {
    return Array.isArray(shape) && Array.isArray(value) ? value.map((item) => project(item, shape[0])) : value;
  }
  if (Array.isArray(shape)) return value;
  return Object.fromEntries(
    Object.entries(shape)
      .filter(([key]) => Object.hasOwn(value, key))
      .map(([key, inner]) => [key, project(value[key], inner)]),
  );
};
const fields = (...keys: string[]) => Object.fromEntries(keys.map((key) => [key, true as const]));
const time = fields('formatted', 'timestamp');
const location = fields('latitude', 'longitude');
const shapes = {
  root: fields('format', 'version', 'userID', 'sourceVerifier'),
  inventory: {
    ...fields(
      'id',
      'ownerId',
      'type',
      'albumIds',
      'caption',
      'createdAt',
      'dateTime',
      'offsetTime',
      'durationSeconds',
      'hash',
      'height',
      'width',
      'modifiedAt',
      'name',
      'updatedAt',
      'visibility',
    ),
    location,
  },
  album: {
    title: true,
    ente: fields('albumID', 'ownerID', 'type', 'magicMetadata', 'pubMagicMetadata', 'sharedMagicMetadata'),
  },
  record: {
    ...fields('title', 'description', 'favorited'),
    creationTime: time,
    photoTakenTime: time,
    modificationTime: time,
    geoData: location,
    ente: {
      ...fields('fileID', 'type', 'component', 'metadata', 'magicMetadata', 'pubMagicMetadata'),
      components: [fields('role', 'path', 'size', 'hash')],
    },
  },
} satisfies Record<string, Shape>;

type Album = { directory: string; record: unknown };
type Placement = { path: string; albumId: unknown; fileId: string; record: unknown; hash: unknown };

/** One sidecar describes one component file in one album folder: `<Album>/metadata/<file name>.json`. */
async function readAlbums(root: string) {
  const albums: Album[] = [];
  const placements: Placement[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === TRASH || entry.name.startsWith('.')) continue;
    const folder = join(root, entry.name);
    let record: unknown;
    try {
      record = JSON.parse(await readFile(join(folder, 'metadata.json'), 'utf8'));
    } catch (error) {
      if (missing(error)) continue;
      return refuse('ENTE_EXPORT_INVALID');
    }
    albums.push({ directory: entry.name, record });
    const albumId = isRecord(record) && isRecord(record.ente) ? record.ente.albumID : undefined;
    let sidecars: string[];
    try {
      sidecars = await readdir(join(folder, 'metadata'));
    } catch (error) {
      if (missing(error)) continue;
      throw error;
    }
    for (const name of sidecars.filter((name) => name.endsWith('.json')).toSorted()) {
      const sidecar = await readJSON(join(folder, 'metadata', name), 'ENTE_EXPORT_INVALID');
      const ente = isRecord(sidecar) && isRecord(sidecar.ente) ? sidecar.ente : {};
      const component = Array.isArray(ente.components)
        ? (ente.components as unknown[]).find((item) => isRecord(item) && item.role === ente.component)
        : undefined;
      const file = isRecord(component) ? component.path : undefined;
      if (typeof file !== 'string' || !file || file.includes('/') || file === '.' || file === '..')
        return refuse('ENTE_EXPORT_INVALID');
      placements.push({
        path: entry.name + '/' + file,
        albumId,
        fileId: String(ente.fileID),
        record: sidecar,
        hash: (component as Record<string, unknown>).hash,
      });
    }
  }
  return { albums, placements };
}

/**
 * Ente Photos, from a folder the owner exported with the official CLI (the Manager never handles their Ente
 * password, second factor or keyring). One account per import: files other accounts shared with it are reported
 * and left out. The export records no CLI version, so `tested` means the export matches the qualified contract.
 */
export const adapter: PreparationAdapter = {
  kind: 'ente',
  databases: ['export'],
  async open(input) {
    const root = await readJSON(join(input.originalsRoot, ENTE_EXPORT_FILE), 'ENTE_EXPORT_INVALID');
    const inventory = await readJSON(join(input.originalsRoot, ENTE_INVENTORY_FILE), 'ENTE_INVENTORY_REQUIRED');
    if (!isRecord(root) || typeof root.userID !== 'string') return refuse('ENTE_EXPORT_INVALID');
    if (!Array.isArray(inventory)) return refuse('ENTE_INVENTORY_REQUIRED');
    const account = root.userID;
    const name = `Ente account ${account}`;
    const shared = (inventory as unknown[]).filter(
      (file): file is Record<string, unknown> =>
        isRecord(file) && typeof file.ownerId === 'string' && file.ownerId !== account,
    );
    const excluded = new Set<unknown>(shared);
    const own = (inventory as unknown[]).filter((file) => !excluded.has(file));
    const ownIds = new Set(own.map((file) => (isRecord(file) ? String(file.id) : '')));
    const sharedIds = new Set(shared.map((file) => String(file.id)));
    const { albums, placements: all } = await readAlbums(input.originalsRoot);
    // Shared files' bytes are never read: only the account's own files are observed and copied.
    const placements = all.filter((placement) => ownIds.has(placement.fileId) || !sharedIds.has(placement.fileId));

    const opened: OpenedPreparationSource = {
      tested: true,
      testedVersion: fixture.provenance.exporter,
      owners() {
        return Promise.resolve([
          {
            sourceId: account,
            name,
            email: null,
            // Ente has no portable password verifier: the owner claims the account through an emailed link.
            login: unrestrictedLogin,
            password: () => Promise.resolve(undefined),
          },
        ]);
      },
      files() {
        return Promise.resolve(placements.map(({ path }) => ({ id: path, path, role: 'original' as const })));
      },
      async manifest(files) {
        const observed = new Map(files.map((file) => [file.id, file]));
        const proofs: (Pick<Placement, 'albumId' | 'record'> & { file: Record<string, unknown> })[] = [];
        for (const placement of placements) {
          const file = observed.get(placement.path) ?? refuse('ENTE_EXPORT_INCOMPLETE');
          proofs.push({
            albumId: placement.albumId,
            record: placement.record,
            file: {
              path: ACCOUNT + '/' + placement.path,
              bytes: file.bytes,
              sha256: file.sha256,
              // The review pass reads no bytes; preparation proves every original against its sidecar hash.
              sourceHash:
                file.sha256 === PLACEHOLDER_SHA256
                  ? placement.hash
                  : await blake2b(join(input.originalsRoot, placement.path)),
              modifiedAt: file.modifiedAt,
            },
          });
        }
        const read = (strict: boolean) => {
          const shape = (value: unknown, of: Shape) => (strict ? value : project(value, of));
          return readEnteManifest({
            // The export names no CLI version: present the qualified contract, the preparation restores the source.
            source: { ...input.source, version: fixture.provenance.exporter, schemaSha256: ENTE_EXPORT_SCHEMA_SHA256 },
            inventory: {
              complete: true,
              ownershipComplete: true,
              privacyComplete: true,
              writersStopped: true,
              revisionBefore: input.source.revision,
              revisionAfter: input.source.revision,
            },
            accounts: [
              {
                id: account,
                name,
                directory: ACCOUNT,
                root: shape(root, shapes.root),
                files: own.map((file) => shape(file, shapes.inventory)),
                albums: albums.map((album) => ({ ...album, record: shape(album.record, shapes.album) })),
                placements: proofs.map((proof) => ({ ...proof, record: shape(proof.record, shapes.record) })),
              },
            ],
            foreignAlbums: 'own-files',
          });
        };
        let result: ReturnType<typeof readEnteManifest>;
        try {
          result = read(true);
        } catch (error) {
          if (!(error instanceof Error) || error.message !== 'Ente source refused: ENTE_EXPORT_INVALID') throw error;
          result = read(false);
          opened.tested = false;
        }
        const { manifest, archive } = result;
        const local = (path: string) => path.slice(ACCOUNT.length + 1);
        manifest.files = manifest.files.map((file) => ({ ...file, path: local(file.path) }));
        for (const record of archive)
          if (record.table === 'frameleaf_ente_placement') record.value.path = local(String(record.value.path));
        manifest.losses.push(...shared.map((file) => sharedFileLoss(String(file.id))));
        return { manifest, archive };
      },
      close() {},
    };
    return opened;
  },
};
