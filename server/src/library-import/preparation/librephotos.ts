import { DateTime } from 'luxon';
import fixture from 'src/library-import/fixtures/librephotos/1.5.1-postgres18.json' with { type: 'json' };
import { classifyLibrephotosFile, normalizeLibrephotosFileCopy } from 'src/library-import/librephotos-files.js';
import { normalizeLibrephotosPhoto } from 'src/library-import/librephotos-metadata.js';
import { openLibrephotosPostgresSnapshot } from 'src/library-import/librephotos-postgres-source.js';
import { type LibrephotosRow, type LibrephotosTable, readLibrephotosManifest } from 'src/library-import/librephotos.js';
import { qualifiedSource } from 'src/library-import/preparation/sqlite.js';
import {
  type PreparationAdapter,
  type PreparationFile,
  unrestrictedLogin,
} from 'src/library-import/preparation/types.js';

/**
 * LibrePhotos records absolute paths inside its backend container; the originals mount stands for the app's
 * `sourceRootPath`, which is `/data` in the official compose files.
 */
export const LIBREPHOTOS_CONTAINER_ROOT = '/data';

const refuse = (code: string): never => {
  throw new Error(`LibrePhotos source refused: ${code}`);
};

/** `postgres://user:password@127.0.0.1:5432/database`: the isolated restore is loopback-only, no TLS. */
export const parseLibrephotosDatabaseUrl = (databaseUrl: string | undefined) => {
  let url: URL;
  try {
    url = new URL(databaseUrl ?? '');
  } catch {
    return refuse('LIBREPHOTOS_DATABASE_URL_INVALID');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.pathname.slice(1))
    return refuse('LIBREPHOTOS_DATABASE_URL_INVALID');
  if (!['127.0.0.1', '[::1]'].includes(url.hostname)) return refuse('LIBREPHOTOS_DATABASE_URL_NOT_LOOPBACK');
  return url.href;
};

export const librephotosFiles = (
  files: LibrephotosRow[],
  copies: LibrephotosRow[],
  root = LIBREPHOTOS_CONTAINER_ROOT,
): PreparationFile[] => {
  const classified = new Map(
    files.map((row) => {
      const file = classifyLibrephotosFile(row, root, []);
      // classifyLibrephotosFile only yields original/sidecar without embedded parents (its role widens to string).
      return [file.id, { ...file, role: file.role as PreparationFile['role'] }] as const;
    }),
  );
  return [
    ...classified.values().map((file) => ({ id: `file:${file.id}`, path: file.path, role: file.role })),
    ...copies.map((row) => {
      const copy = normalizeLibrephotosFileCopy(row, root);
      const original = classified.get(copy.fileId) ?? refuse('LIBREPHOTOS_RELATIONSHIPS_INVALID');
      return { id: `copy:${copy.id}`, path: copy.path, role: original.role };
    }),
  ];
};

/**
 * Manual dates and EXIF dates without an offset are wall-clock values; LibrePhotos shows them in the owner's
 * default time zone, so that zone's offset at the moment is the reviewed offset (UTC when the zone is unknown).
 */
export const librephotosCaptureOffsets = (photos: LibrephotosRow[], users: LibrephotosRow[]) => {
  const owners = new Map(users.map((user) => [String(user.id), user]));
  const offsets: Record<string, number> = {};
  for (const row of photos) {
    const owner = owners.get(String(row.owner_id));
    if (!owner) continue;
    let photo: ReturnType<typeof normalizeLibrephotosPhoto>;
    try {
      photo = normalizeLibrephotosPhoto({ photo: row, owner, tags: [] });
    } catch {
      continue; // The manifest refuses the same row with its own code.
    }
    if (!photo.localDateTime || photo.metadata.takenAt) continue;
    const zone = typeof owner.default_timezone === 'string' ? owner.default_timezone : 'UTC';
    const local = DateTime.fromISO(photo.localDateTime, { zone });
    offsets[photo.id] = local.isValid ? local.offset : 0;
  }
  return offsets;
};

/** LibrePhotos PostgreSQL restore; LibrePhotos has no second factor or external login in the qualified schema. */
export const adapter: PreparationAdapter = {
  kind: 'librephotos',
  databases: ['postgres'],
  async open(input) {
    const root = input.sourceRootPath ?? LIBREPHOTOS_CONTAINER_ROOT;
    // Best effort records whether every pin matched, so one exclusive snapshot decides `tested`.
    const snapshot = await openLibrephotosPostgresSnapshot(
      parseLibrephotosDatabaseUrl(input.databaseUrl),
      fixture.source.version,
      true,
      { bestEffort: true },
    );
    const all = async (table: LibrephotosTable) => {
      const rows: LibrephotosRow[] = [];
      for await (const batch of snapshot.rows(table)) rows.push(...batch);
      return rows;
    };
    return {
      tested: snapshot.qualified,
      testedVersion: fixture.source.version,
      async owners() {
        return (await all('api_user')).map((user) => ({
          sourceId: String(user.id),
          name: [user.first_name, user.last_name].filter(Boolean).join(' ') || String(user.username ?? user.id),
          email: typeof user.email === 'string' && user.email ? user.email : null,
          login: { ...unrestrictedLogin, accountEnabled: user.is_active === 1n },
          password: (context) => snapshot.password(context),
        }));
      },
      async files() {
        return librephotosFiles(await all('api_file'), await all('api_filecopy'), root);
      },
      async manifest(files) {
        const reviewedCaptureOffsets = librephotosCaptureOffsets(await all('api_photo'), await all('api_user'));
        return readLibrephotosManifest(
          {
            version: fixture.source.version,
            schemaSha256: fixture.schemaSha256,
            rows: (table) => snapshot.rows(table),
          },
          {
            source: qualifiedSource(input.source, fixture),
            inventory: {
              complete: true,
              ownershipComplete: true,
              privacyComplete: true,
              writersStopped: true,
              revisionBefore: input.source.revision,
              revisionAfter: input.source.revision,
            },
            sourceRoot: root,
            files,
            reviewedCaptureOffsets,
          },
        );
      },
      close: () => snapshot.close(),
    };
  },
};
