import fixture from 'src/library-import/fixtures/lychee/7.12.0-sqlite.json' with { type: 'json' };
import { resolveLycheeOriginals } from 'src/library-import/lychee-files.js';
import { openLycheeSnapshot, readLycheeManifest } from 'src/library-import/lychee.js';
import { openSnapshotBestEffort, qualifiedSource } from 'src/library-import/preparation/sqlite.js';
import { type PreparationAdapter, unrestrictedLogin } from 'src/library-import/preparation/types.js';

const inventory = (revision: string) => ({
  complete: true as const,
  ownershipComplete: true as const,
  privacyComplete: true as const,
  writersStopped: true as const,
  revisionBefore: revision,
  revisionAfter: revision,
});

/** Lychee SQLite: originals live under the `images` disk (the uploads mount); LDAP accounts have no local verifier. */
export const adapter: PreparationAdapter = {
  kind: 'lychee',
  databases: ['sqlite'],
  open(input) {
    const { snapshot, tested } = openSnapshotBestEffort(
      (bestEffort) => openLycheeSnapshot(input.snapshotPath!, fixture.source.version, { bestEffort }),
      input.source.schemaSha256 === fixture.schemaSha256,
    );
    const rows = (table: Parameters<typeof snapshot.rows>[0]) => [...snapshot.rows(table)].flat();
    return Promise.resolve({
      tested,
      testedVersion: fixture.source.version,
      owners() {
        return Promise.resolve(
          rows('users').map((user) => ({
            sourceId: String(user.id),
            name: String(user.display_name || user.username || user.id),
            email: typeof user.email === 'string' && user.email ? user.email : null,
            login: { ...unrestrictedLogin, externalIdentityRequired: user.is_ldap === 1n },
            password: (context) => snapshot.password(context),
          })),
        );
      },
      files() {
        const variants = Map.groupBy(rows('size_variants'), (variant) => String(variant.photo_id));
        return Promise.resolve(
          rows('photos').flatMap((photo) =>
            resolveLycheeOriginals(photo, variants.get(String(photo.id)) ?? []).map((file) => ({
              id: file.role === 'original' ? `variant:${file.variantId}` : `companion:${file.photoId}`,
              path: file.path,
              role: file.role,
            })),
          ),
        );
      },
      manifest(files) {
        return Promise.resolve(
          readLycheeManifest(snapshot, {
            source: qualifiedSource(input.source, fixture),
            inventory: inventory(input.source.revision),
            files,
            // ponytail: tag/person smart albums stay archived (reported loss) until the Manager can materialize them.
            materializedAlbums: {},
          }),
        );
      },
      close: () => snapshot.close(),
    });
  },
};
